import type { Session, Snapshot } from "@agent-rishi/contracts";

/** Which of a project's sessions the project home lists. */
export type SessionView = "active" | "archived";

/**
 * A project's active agent sessions, most recently updated first. Archived ones are paged from
 * the server (`useArchivedSessions`): the snapshot carries only the recent ones.
 */
export function activeSessions(sessions: readonly Session[], projectId: string): Session[] {
  return sessions
    .filter((s) => s.projectId === projectId && s.role === "agent" && !s.archivedAt)
    .sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt));
}

/** How many of a project's agent sessions are active and archived. */
export function sessionCounts(
  snapshot: Pick<Snapshot, "sessions" | "archivedSessionCounts">,
  projectId: string,
): Record<SessionView, number> {
  return {
    active: activeSessions(snapshot.sessions, projectId).length,
    archived: snapshot.archivedSessionCounts[projectId] ?? 0,
  };
}
