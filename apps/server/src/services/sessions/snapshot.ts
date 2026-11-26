import type { SessionSnapshot, SessionSnapshotQuery, Thread } from "@agent-rishi/contracts";
import { and, asc, eq, inArray } from "drizzle-orm";
import { rowToItemRecord, rowToSession, rowToThread, rowToTurn } from "../../db/rows";
import { items, sessions, threads, turns } from "../../db/schema";
import { turnsOldestFirst } from "../../db/turn-order";
import type { AppServices } from "../container";
import { notFound } from "../errors";
import { clientItemRecord } from "./client-items";

type Deps = Pick<AppServices, "db" | "store" | "artifacts">;

/** Ids per `IN (...)` list, well under SQLite's bound-parameter limit. */
const IN_CHUNK = 500;

/**
 * `GET /api/sessions/:id/snapshot`: the whole session, or with `q.turns` only the latest root
 * turns (§6), so opening a long-lived session (a PM, the orchestrator, the scout) costs a page
 * rather than its whole history. A page holds its root turns and their items, plus every
 * subagent thread those items started, with all of that thread's turns and items.
 */
export function sessionSnapshot(
  s: Deps,
  sessionId: string,
  q: SessionSnapshotQuery = {},
): SessionSnapshot {
  // Read the head first: anything appended later arrives through the session watch.
  const seq = s.store.headSeq();
  const row = s.db.select().from(sessions).where(eq(sessions.id, sessionId)).get();
  if (!row) throw notFound("No such session", "session_not_found");
  const session = rowToSession(row);
  const allThreads = s.db
    .select()
    .from(threads)
    .where(eq(threads.sessionId, sessionId))
    .all()
    .map(rowToThread);
  const toClient = (r: ItemRow) => clientItemRecord(rowToItemRecord(r), s.artifacts);

  if (q.turns === undefined) {
    return {
      seq,
      session,
      threads: allThreads,
      // Oldest first, so a thread's last turn is its latest one.
      turns: s.db
        .select()
        .from(turns)
        .where(eq(turns.sessionId, sessionId))
        .orderBy(...turnsOldestFirst)
        .all()
        .map(rowToTurn),
      items: s.db
        .select()
        .from(items)
        .where(eq(items.sessionId, sessionId))
        .orderBy(asc(items.threadId), asc(items.position))
        .all()
        .map(toClient),
      earlierTurns: 0,
    };
  }

  const rootId = session.rootThreadId ?? allThreads.find((t) => !t.parentThreadId)?.id ?? null;
  const rootTurns = rootId
    ? s.db
        .select()
        .from(turns)
        .where(and(eq(turns.sessionId, sessionId), eq(turns.threadId, rootId)))
        .orderBy(...turnsOldestFirst)
        .all()
        .map(rowToTurn)
    : [];
  let end = rootTurns.length;
  if (q.before !== undefined) {
    end = rootTurns.findIndex((t) => t.id === q.before);
    if (end === -1) throw notFound("No such turn in this session's thread", "turn_not_found");
  }
  let start = Math.max(0, end - q.turns);
  if (q.item !== undefined) {
    const turnId = rootTurnOf(s, sessionId, q.item, allThreads, rootId);
    const at = turnId ? rootTurns.findIndex((t) => t.id === turnId) : -1;
    if (at !== -1 && at < start) start = at;
  }
  const page = rootTurns.slice(start, end);
  const pageTurnIds = page.map((t) => t.id);
  const rootItems = rootId
    ? inChunks(pageTurnIds, (ids) =>
        s.db
          .select()
          .from(items)
          .where(
            and(
              eq(items.sessionId, sessionId),
              eq(items.threadId, rootId),
              inArray(items.turnId, ids),
            ),
          )
          .all(),
      )
    : [];

  // Subagent threads started by an included item (named by the thread, or by the subagent
  // card), then theirs, all the way down.
  const included = new Set<string>(rootId ? [rootId] : []);
  const childItems: ItemRow[] = [];
  let found = rootItems;
  while (found.length > 0) {
    const itemIds = new Set(found.map((r) => r.id));
    const cardThreads = new Set(
      found.flatMap((r) => (r.data.kind === "subagent" ? [r.data.childThreadId] : [])),
    );
    const ids = allThreads
      .filter(
        (t) =>
          t.parentThreadId !== null &&
          !included.has(t.id) &&
          (cardThreads.has(t.id) || (t.parentItemId !== null && itemIds.has(t.parentItemId))),
      )
      .map((t) => t.id);
    for (const id of ids) included.add(id);
    found = inChunks(ids, (chunk) =>
      s.db
        .select()
        .from(items)
        .where(and(eq(items.sessionId, sessionId), inArray(items.threadId, chunk)))
        .all(),
    );
    childItems.push(...found);
  }
  const childIds = [...included].filter((id) => id !== rootId);
  const childTurns = inChunks(childIds, (chunk) =>
    s.db
      .select()
      .from(turns)
      .where(and(eq(turns.sessionId, sessionId), inArray(turns.threadId, chunk)))
      .orderBy(...turnsOldestFirst)
      .all()
      .map(rowToTurn),
  );

  return {
    seq,
    session,
    threads: allThreads.filter((t) => included.has(t.id)),
    // Oldest first like the whole session (a stable sort keeps each thread's own order).
    turns: [...page, ...childTurns].sort(byStart),
    items: [...rootItems, ...childItems].sort(byThreadPosition).map(toClient),
    earlierTurns: start,
  };
}

type ItemRow = typeof items.$inferSelect;

const byStart = (a: { startedAt: string }, b: { startedAt: string }) =>
  a.startedAt < b.startedAt ? -1 : a.startedAt > b.startedAt ? 1 : 0;

const byThreadPosition = (a: ItemRow, b: ItemRow) =>
  a.threadId === b.threadId ? a.position - b.position : a.threadId < b.threadId ? -1 : 1;

/**
 * The root turn an item belongs to: its own turn in the root thread, or the turn of the subagent
 * card that started its thread (walking up nested subagents). Null when there is none.
 */
function rootTurnOf(
  s: Deps,
  sessionId: string,
  itemId: string,
  allThreads: Thread[],
  rootId: string | null,
): string | null {
  const byId = new Map(allThreads.map((t) => [t.id, t]));
  const find = (id: string) =>
    s.db
      .select({ threadId: items.threadId, turnId: items.turnId })
      .from(items)
      .where(and(eq(items.sessionId, sessionId), eq(items.id, id)))
      .get();
  let at = find(itemId);
  for (let depth = 0; at && depth < 16; depth++) {
    if (at.threadId === rootId) return at.turnId;
    const parentItemId = byId.get(at.threadId)?.parentItemId;
    at = parentItemId ? find(parentItemId) : undefined;
  }
  return null;
}

/** Run a query per chunk of ids and concatenate the rows (none for no ids). */
function inChunks<T>(ids: string[], query: (chunk: string[]) => T[]): T[] {
  const out: T[] = [];
  for (let i = 0; i < ids.length; i += IN_CHUNK) out.push(...query(ids.slice(i, i + IN_CHUNK)));
  return out;
}
