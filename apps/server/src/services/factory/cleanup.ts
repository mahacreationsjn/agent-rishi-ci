import type { FactoryItem, FactoryItemStage, FactoryLoop, Session } from "@agent-rishi/contracts";
import { errorMessage } from "../errors";
import type { SessionRepo } from "../sessions/repo";
import type { FactoryContext } from "./context";
import { itemSessionIds, sessionsByWorkKey } from "./item-cost";
import { isBusy, isFactorySession, LENS_WORK_KEY_PREFIX, SCOUT_WORK_KEY } from "./sessions";
import { FINISHED_STAGES } from "./store";

/**
 * Cleaning up finished work (§10.1, §9): once an item is done, the factory archives its builder
 * and reviewer sessions through the normal archive path, which removes their worktrees. The
 * branch, checkpoints and transcript stay, and a message to a session brings it (and its
 * worktree) back. A session that is busy is never cut off: the item waits for it. A reviewer
 * that failed and was replaced is archived as soon as its replacement starts (issue #411); the
 * item keeps its id (`sessionIds`), so the item page still links to it.
 */

/** The scout and its area reviewers ("lenses") are long-lived: never archived with an item. */
function longLived(s: Session): boolean {
  return s.workKey === SCOUT_WORK_KEY || s.workKey.startsWith(LENS_WORK_KEY_PREFIX);
}

/** Factory sessions an item may archive: not archived yet, and not long-lived. */
function archivable(s: Session | undefined): s is Session {
  return s !== undefined && !s.archivedAt && isFactorySession(s) && !longLived(s);
}

/**
 * Whether a session ended in failure: it failed, or it was stopped after its last turn failed
 * (the factory stops a reviewer whose provider hit its usage limit before it replaces it).
 */
function endedInFailure(ctx: FactoryContext, s: Session): boolean {
  if (s.status === "failed") return true;
  if (s.status !== "stopped") return false;
  const last = ctx.repo.rootTurnIds(s).at(-1);
  return last !== undefined && ctx.repo.turn(s.id, last)?.status === "failed";
}

/**
 * The item's sessions that ended in failure and aren't its current builder or reviewer any
 * more, from every session that ever worked on it (`sessionIds`), wherever they worked: also
 * one let go without being recorded as an earlier session (by a version before #411). Those
 * without a worktree of their own (a reviewer in another session's) come first, so the
 * worktree they worked in isn't kept for them.
 */
function replacedFailures(ctx: FactoryContext, item: FactoryItem): Session[] {
  const current = new Set([item.builderSessionId, item.reviewerSessionId]);
  return (item.sessionIds ?? [])
    .filter((id) => !current.has(id))
    .map((id) => ctx.repo.find(id)?.session)
    .filter((s): s is Session => archivable(s) && endedInFailure(ctx, s))
    .sort((a, b) => Number(Boolean(a.worktreePath)) - Number(Boolean(b.worktreePath)));
}

/**
 * The item's sessions that aren't archived yet, in the order to archive them: the factory
 * sessions working in the builder's worktree first (its reviewers, including one restarted
 * after it failed), so the builder's worktree isn't kept for a session still shown in it; then
 * the sessions of the item that failed and were replaced, wherever they worked; then the
 * reviewer; then the builder.
 */
export function sessionsToArchive(ctx: FactoryContext, item: FactoryItem): Session[] {
  const find = (id: string | null) => (id ? ctx.repo.find(id)?.session : undefined);
  const builder = find(item.builderSessionId);
  const inWorktree = builder?.worktreePath
    ? ctx.repo
        .inFolder(builder.worktreePath)
        .filter((s) => s.id !== builder.id && s.projectId === item.projectId)
    : [];
  const seen = new Set<string>();
  return [
    ...inWorktree,
    ...replacedFailures(ctx, item),
    find(item.reviewerSessionId),
    builder,
  ].filter((s): s is Session => {
    if (!s || seen.has(s.id)) return false;
    seen.add(s.id);
    return archivable(s);
  });
}

/**
 * The item's reviewer is let go (it failed, its provider did, or a fresh one takes over from
 * it): it becomes an earlier session, which the loop archives once a fresh reviewer has started
 * (`archiveEarlier`), so a replaced reviewer doesn't stay in the sidebar as a failed row.
 */
export function letGoReviewer(
  item: FactoryItem,
): Pick<FactoryItem, "reviewerSessionId" | "earlierSessionIds"> {
  const old = item.reviewerSessionId;
  return {
    reviewerSessionId: null,
    earlierSessionIds: old
      ? [...new Set([...item.earlierSessionIds, old])]
      : item.earlierSessionIds,
  };
}

/**
 * Whether the item still waits for the reviewer that replaces one let go: in verification with
 * no reviewer. Until it starts, the failed one stays, and the item's note says why.
 */
function awaitingReviewer(item: FactoryItem): boolean {
  return item.stage === "verifying" && !item.reviewerSessionId;
}

/**
 * A failed item the PM may still allow over the size limit (`factory_allow_large_change`): the
 * size check failed and its pull request is still open. It needs the builder's worktree then.
 */
export function waitingOnLargeChange(ctx: FactoryContext, item: FactoryItem): boolean {
  if (item.stage !== "failed" || !item.pr) return false;
  if (!item.checks.some((c) => c.name === "size" && c.state === "fail")) return false;
  const state = ctx.github.prRef(item.projectId, item.pr.number)?.state ?? item.pr.state;
  return state === "open" || state === "draft";
}

/**
 * The loop's cleanup step. A finished item's sessions are archived once (`sessionsArchivedAt`),
 * so a session someone restores stays; it waits while one of them is busy, or while the PM may
 * still allow it over the size limit. An earlier attempt's sessions (after a retry) and
 * replaced reviewers are archived once none of them is busy (a failed reviewer once its
 * replacement has started). Escalated items and merges whose main CI is still watched aren't
 * finished. The archives run in the background, so a slow worktree removal never holds up the
 * loop.
 */
export function archiveFinished(ctx: FactoryContext, projectId: string): void {
  for (const item of ctx.store.itemsToClean(projectId)) {
    if (item.earlierSessionIds.length > 0) archiveEarlier(ctx, item);
    if (!FINISHED_STAGES.includes(item.stage) || item.sessionsArchivedAt) continue;
    if (waitingOnLargeChange(ctx, item)) continue;
    const sessions = sessionsToArchive(ctx, item);
    if (sessions.some(isBusy)) continue;
    const at = ctx.now().toISOString();
    ctx.store.updateItem(item.id, (i) => ({ ...i, sessionsArchivedAt: at }), { touch: false });
    if (sessions.length > 0) ctx.archiveSessions(sessions.map((s) => s.id));
  }
}

/**
 * Archive the earlier sessions (attempts before a retry, replaced reviewers) once none of them
 * is busy. One that ended in failure waits while the item still waits for its replacement
 * reviewer (`awaitingReviewer`). Each is handled once: a session restored after stays.
 */
function archiveEarlier(ctx: FactoryContext, item: FactoryItem): void {
  const sessions = item.earlierSessionIds
    .map((id) => ctx.repo.find(id)?.session)
    .filter(archivable);
  if (sessions.some(isBusy)) return;
  const held = new Set(
    awaitingReviewer(item) ? sessions.filter((s) => endedInFailure(ctx, s)).map((s) => s.id) : [],
  );
  const handled = new Set(item.earlierSessionIds.filter((id) => !held.has(id)));
  if (handled.size === 0) return;
  ctx.store.updateItem(
    item.id,
    (i) => ({ ...i, earlierSessionIds: i.earlierSessionIds.filter((id) => !handled.has(id)) }),
    { touch: false },
  );
  const archive = sessions.filter((s) => handled.has(s.id));
  if (archive.length > 0) ctx.archiveSessions(archive.map((s) => s.id));
}

/** Stages after which even the item's current session has nothing left to do or show. */
const DONE_STAGES: FactoryItemStage[] = ["merged", "rejected", "reverted"];

/**
 * The one-time sweep (issue #411): earlier versions never archived a factory session that
 * failed and was replaced, so those stayed in the sidebar as failed rows. On the loop's first
 * tick after the upgrade, every one whose item has moved on is archived: the item finished, or
 * a later session became its current builder or reviewer. A failed session that is still the
 * current builder or reviewer of an item in play (a failed item included) stays, since it needs
 * attention. Recorded on the loop (`failedSessionsSweptAt`), so it runs once: it reads every
 * failed or stopped session not archived yet, however many sessions came after it.
 */
export function sweepFailedSessions(
  ctx: FactoryContext,
  projectId: string,
  loop: FactoryLoop,
): FactoryLoop {
  if (loop.failedSessionsSweptAt) return loop;
  const failed = ctx.repo
    .unarchivedAgents(projectId, ["failed", "stopped"])
    .filter((s) => archivable(s) && endedInFailure(ctx, s));
  const archive = new Set<string>();
  if (failed.length > 0) {
    const items = ctx.store.items(projectId);
    const inPlay = items.filter((i) => !DONE_STAGES.includes(i.stage));
    const current = new Set(inPlay.flatMap((i) => [i.builderSessionId, i.reviewerSessionId]));
    const created = (id: string | null) => (id && ctx.repo.find(id)?.session.createdAt) || "";
    const byId = new Map(failed.map((s) => [s.id, s]));
    const byKey = sessionsByWorkKey(failed);
    for (const item of items) {
      const finished = FINISHED_STAGES.includes(item.stage);
      const latest = [created(item.builderSessionId), created(item.reviewerSessionId)]
        .sort()
        .at(-1);
      for (const id of itemSessionIds(item, byKey)) {
        const s = byId.get(id);
        if (!s || current.has(id)) continue;
        if (finished || (latest ?? "") > s.createdAt) archive.add(id);
      }
    }
  }
  if (archive.size > 0) {
    // Those without a worktree of their own first, so the one they worked in isn't kept.
    const ordered = failed.filter((s) => archive.has(s.id));
    ordered.sort((a, b) => Number(Boolean(a.worktreePath)) - Number(Boolean(b.worktreePath)));
    ctx.log?.(`factory: archiving ${ordered.length} failed sessions left from before`);
    ctx.archiveSessions(ordered.map((s) => s.id));
  }
  return { ...loop, failedSessionsSweptAt: ctx.now().toISOString() };
}

export interface SessionArchiverDeps {
  repo: Pick<SessionRepo, "find">;
  /** The session archive path (`WorktreeCleanup.archive`). */
  archive: (sessionId: string) => Promise<unknown>;
  log?: (message: string) => void;
}

/**
 * Archives finished work's sessions one at a time, in the order queued. Removing a worktree can
 * take a while, so this never runs inside a tick. A session that is gone, archived already or
 * busy again (someone messaged it) by its turn is left alone. Failures are logged; the hourly
 * worktree sweep retries removals that failed.
 */
export class SessionArchiver {
  private chain: Promise<void> = Promise.resolve();

  constructor(private readonly deps: SessionArchiverDeps) {}

  push(sessionIds: string[]): void {
    this.chain = this.chain
      .then(async () => {
        for (const id of sessionIds) {
          const s = this.deps.repo.find(id)?.session;
          if (!s || s.archivedAt || isBusy(s)) continue;
          await this.deps
            .archive(id)
            .catch((error: unknown) =>
              this.deps.log?.(`factory: archiving session ${id}: ${errorMessage(error)}`),
            );
        }
      })
      .catch((error: unknown) => this.deps.log?.(`factory: archiving: ${errorMessage(error)}`));
  }

  /** Resolves once everything queued so far is done. */
  idle(): Promise<void> {
    return this.chain;
  }
}
