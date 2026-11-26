import {
  ARCHIVED_SESSIONS_DEFAULT_LIMIT,
  type ArchivedSessionsPage,
  type ArchivedSessionsQueryInit,
  type Session,
} from "@agent-rishi/contracts";

/** A project's archived agents and its PM's earlier conversations, as the server lists them. */
const archivedAgents = (sessions: readonly Session[], projectId?: string) =>
  sessions.filter(
    (s) => s.role !== "orchestrator" && s.archivedAt && (!projectId || s.projectId === projectId),
  );

/** Archived sessions per project, as the server's snapshot counts them. */
export function mockArchivedCounts(sessions: readonly Session[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const s of archivedAgents(sessions)) {
    if (s.projectId) counts[s.projectId] = (counts[s.projectId] ?? 0) + 1;
  }
  return counts;
}

/**
 * A page of a project's archived sessions, most recently archived first. The mock keeps every
 * session in its snapshot, so it pages through those; the cursor is an offset.
 */
export function mockArchivedPage(
  sessions: readonly Session[],
  projectId: string,
  { cursor, limit = ARCHIVED_SESSIONS_DEFAULT_LIMIT }: ArchivedSessionsQueryInit = {},
): ArchivedSessionsPage {
  const all = archivedAgents(sessions, projectId).sort(
    (a, b) => (b.archivedAt ?? "").localeCompare(a.archivedAt ?? "") || b.id.localeCompare(a.id),
  );
  const start = cursor ? Number(cursor) : 0;
  const end = start + Number(limit);
  return { sessions: all.slice(start, end), nextCursor: end < all.length ? String(end) : null };
}
