import {
  type ArchivedSessionsPage,
  type ArchivedSessionsQuery,
  type Session,
  SNAPSHOT_ARCHIVED_SESSIONS_DAYS,
  SNAPSHOT_ARCHIVED_SESSIONS_MAX,
} from "@agent-rishi/contracts";
import { and, asc, count, desc, eq, gte, inArray, isNotNull, isNull, lt, or } from "drizzle-orm";
import type { Db } from "../../db/client";
import { rowToSession } from "../../db/rows";
import { sessions } from "../../db/schema";
import { badRequest } from "../errors";

const DAY_MS = 24 * 60 * 60 * 1000;

/** The roles a project's Archived list shows: agents, and its PM started fresh or moved (§8.1). */
const LISTED_ROLES: Session["role"][] = ["agent", "pm"];

/**
 * The app snapshot's sessions (§6): every session that isn't archived, plus the most recently
 * archived ones from the last few days, oldest first. A busy factory archives dozens a day, so
 * the rest are left to `archivedSessionsPage` and `GET /api/sessions/:id`.
 */
export function snapshotSessions(db: Db, now = Date.now()): Session[] {
  const since = new Date(now - SNAPSHOT_ARCHIVED_SESSIONS_DAYS * DAY_MS).toISOString();
  const recent = db
    .select({ id: sessions.id })
    .from(sessions)
    .where(and(isNotNull(sessions.archivedAt), gte(sessions.archivedAt, since)))
    .orderBy(desc(sessions.archivedAt))
    .limit(SNAPSHOT_ARCHIVED_SESSIONS_MAX);
  return db
    .select()
    .from(sessions)
    .where(or(isNull(sessions.archivedAt), inArray(sessions.id, recent)))
    .orderBy(asc(sessions.createdAt))
    .all()
    .map(rowToSession);
}

/**
 * How many archived sessions each project has (projects with none are left out): its agents
 * and its PM's earlier conversations (§8.1).
 */
export function archivedSessionCounts(db: Db): Record<string, number> {
  const rows = db
    .select({ projectId: sessions.projectId, n: count() })
    .from(sessions)
    .where(
      and(
        inArray(sessions.role, LISTED_ROLES),
        isNotNull(sessions.archivedAt),
        isNotNull(sessions.projectId),
      ),
    )
    .groupBy(sessions.projectId)
    .all();
  const counts: Record<string, number> = {};
  for (const r of rows) if (r.projectId) counts[r.projectId] = r.n;
  return counts;
}

/** The cursor after `session`: its archive time and id (ids break ties). */
function cursorOf(session: Session): string {
  return `${session.archivedAt}|${session.id}`;
}

function parseCursor(cursor: string): { at: string; id: string } {
  const bar = cursor.indexOf("|");
  const at = cursor.slice(0, bar);
  const id = cursor.slice(bar + 1);
  if (bar < 1 || !id || Number.isNaN(Date.parse(at))) {
    throw badRequest("Invalid cursor", "invalid_cursor");
  }
  return { at, id };
}

/**
 * A page of a project's archived sessions, the most recently archived first (the project home's
 * Archived list): its agents and its PM's earlier conversations. `nextCursor` continues below
 * the last one.
 */
export function archivedSessionsPage(
  db: Db,
  projectId: string,
  query: ArchivedSessionsQuery,
): ArchivedSessionsPage {
  const after = query.cursor ? parseCursor(query.cursor) : null;
  const rows = db
    .select()
    .from(sessions)
    .where(
      and(
        eq(sessions.projectId, projectId),
        inArray(sessions.role, LISTED_ROLES),
        isNotNull(sessions.archivedAt),
        after
          ? or(
              lt(sessions.archivedAt, after.at),
              and(eq(sessions.archivedAt, after.at), lt(sessions.id, after.id)),
            )
          : undefined,
      ),
    )
    .orderBy(desc(sessions.archivedAt), desc(sessions.id))
    .limit(query.limit + 1)
    .all()
    .map(rowToSession);
  const page = rows.slice(0, query.limit);
  const last = page.at(-1);
  return { sessions: page, nextCursor: rows.length > query.limit && last ? cursorOf(last) : null };
}
