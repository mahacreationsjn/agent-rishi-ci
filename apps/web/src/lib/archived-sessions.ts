import type { ArchivedSessionsPage, EventEnvelope, Session } from "@agent-rishi/contracts";
import { type InfiniteData, type QueryClient, useInfiniteQuery } from "@tanstack/react-query";
import { useClient } from "./api";
import { sessionRecordKey } from "./queries";

/** A project's archived sessions, a page at a time (the project home's Archived list). */
export const archivedSessionsKey = (projectId: string) => ["archived-sessions", projectId] as const;

/**
 * A project's archived sessions (its agents and its PM's earlier conversations), most recently
 * archived first, paged from the server: the snapshot carries only the recent ones (§6).
 */
export function useArchivedSessions(projectId: string) {
  const client = useClient();
  return useInfiniteQuery({
    queryKey: archivedSessionsKey(projectId),
    queryFn: ({ pageParam }) =>
      client.listArchivedSessions(projectId, pageParam ? { cursor: pageParam } : {}),
    initialPageParam: null as string | null,
    getNextPageParam: (last: ArchivedSessionsPage) => last.nextCursor,
  });
}

/**
 * Keep the session queries outside the snapshot in step with a live session event: the copy of
 * a session fetched by id (`useSessionLookup`) takes the new one, and a project's archived list
 * reloads when a session in it changes or another one is archived.
 */
export function syncSessionQueries(queryClient: QueryClient, env: EventEnvelope): void {
  if (env.type !== "session.created" && env.type !== "session.updated") return;
  const { session } = env.payload;
  const record = sessionRecordKey(session.id);
  if (queryClient.getQueryData<Session>(record)) queryClient.setQueryData(record, session);
  if (!session.projectId || session.role === "orchestrator") return;
  const key = archivedSessionsKey(session.projectId);
  const list = queryClient.getQueryData<InfiniteData<ArchivedSessionsPage>>(key);
  if (!list) return;
  const listed = list.pages.some((p) => p.sessions.some((s) => s.id === session.id));
  if (listed || session.archivedAt) void queryClient.invalidateQueries({ queryKey: key });
}
