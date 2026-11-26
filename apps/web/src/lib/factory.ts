import type {
  EventEnvelope,
  FactoryItemStage,
  FactoryStatus,
  ScorecardDays,
} from "@agent-rishi/contracts";
import { type QueryClient, useQuery } from "@tanstack/react-query";
import { useClient } from "./api";
import { ApiRequestError } from "./api/http";

/** Query keys of the factory views (§10.1); all start with `factory`. */
export const factoryKeys = {
  all: ["factory"] as const,
  status: (projectId: string) => ["factory", "status", projectId] as const,
  item: (projectId: string, itemId: string) => ["factory", "item", projectId, itemId] as const,
  vision: (projectId: string) => ["factory", "vision", projectId] as const,
  scorecard: (projectId: string, days: ScorecardDays) =>
    ["factory", "scorecard", projectId, days] as const,
};

const FACTORY_EVENTS = new Set<string>([
  "factory.loop.updated",
  "factory.item.updated",
  "factory.digest.created",
  "factory.lesson.updated",
  "project.updated",
  "settings.updated",
]);

/** Refetch factory views when the loop, its items, the project or the kill switches change. */
export function invalidateFactory(queryClient: QueryClient, env: EventEnvelope): void {
  if (FACTORY_EVENTS.has(env.type)) {
    void queryClient.invalidateQueries({ queryKey: ["factory", "status"] });
    void queryClient.invalidateQueries({ queryKey: ["factory", "item"] });
    refreshScorecard(queryClient);
  }
}

/**
 * Most often an open scorecard refetches on factory events. It reads every item and the ledger,
 * and covers finished work, so a busy factory's stream of events needn't reach it one by one.
 */
export const SCORECARD_REFRESH_MS = 15_000;

/** The refetch each query client has scheduled for its scorecard, if any. */
const scorecardRefresh = new WeakMap<QueryClient, ReturnType<typeof setTimeout>>();

/**
 * A factory event: the scorecard is stale at once (another window opened next is fetched
 * afresh), and the open one refetches once, `SCORECARD_REFRESH_MS` after the first event of a
 * burst, covering every event until then.
 */
function refreshScorecard(queryClient: QueryClient): void {
  void queryClient.invalidateQueries({ queryKey: ["factory", "scorecard"], refetchType: "none" });
  if (scorecardRefresh.has(queryClient)) return;
  const timer = setTimeout(() => {
    scorecardRefresh.delete(queryClient);
    // Refetched only while the scorecard is open (an inactive query just stays stale).
    void queryClient.invalidateQueries({ queryKey: ["factory", "scorecard"] });
  }, SCORECARD_REFRESH_MS);
  scorecardRefresh.set(queryClient, timer);
}

/** Status refresh while work is in flight: spend and session counts move without events. */
export const BUSY_REFRESH_MS = 30_000;
/**
 * Status refresh while the factory is idle. Everything the loop changes arrives as an event
 * (above); this slow poll only keeps spend from the project's other sessions (budget scope
 * "project") and the "last check" current, since a loop check that changes nothing sends none.
 */
export const IDLE_REFRESH_MS = 5 * 60_000;

/** How often an open factory view refetches its status: fast only while work is in flight. */
export function statusRefreshMs(status: FactoryStatus | undefined): number {
  const busy =
    !status ||
    status.activeSessions > 0 ||
    status.inProgress.length > 0 ||
    status.loopState === "discovering";
  return busy ? BUSY_REFRESH_MS : IDLE_REFRESH_MS;
}

/**
 * The factory panel's status: refetched on every factory event, and polled (see
 * `statusRefreshMs`), so its "last check" is as of the last refresh.
 */
export function useFactoryStatus(projectId: string, enabled = true) {
  const client = useClient();
  return useQuery({
    queryKey: factoryKeys.status(projectId),
    queryFn: () => client.factory.status(projectId),
    enabled,
    refetchInterval: (query) => statusRefreshMs(query.state.data),
  });
}

/** Stages in which agents may be spending on an item, so its cost moves without events. */
const SPENDING_STAGES = new Set<FactoryItemStage>(["backlog", "building", "verifying"]);

/**
 * One work item and what it cost so far (`data.item`, `data.cost`): refetched on every factory
 * event, and polled while agents may be spending on it, since usage arrives without one.
 */
export function useFactoryItem(projectId: string, itemId: string) {
  const client = useClient();
  return useQuery({
    queryKey: factoryKeys.item(projectId, itemId),
    queryFn: () => client.factory.item(projectId, itemId),
    refetchInterval: (query) => {
      const stage = query.state.data?.item.stage;
      return stage && SPENDING_STAGES.has(stage) ? BUSY_REFRESH_MS : false;
    },
  });
}

/**
 * The factory scorecard over the last `days` (§10.1): fetched on demand (`enabled` while the
 * panel's Scorecard is open), refetched on factory events at most every `SCORECARD_REFRESH_MS`.
 * Not polled: it covers finished work.
 */
export function useFactoryScorecard(projectId: string, days: ScorecardDays, enabled = true) {
  const client = useClient();
  return useQuery({
    queryKey: factoryKeys.scorecard(projectId, days),
    queryFn: () => client.factory.scorecard(projectId, days),
    enabled,
  });
}

export function useVision(projectId: string) {
  const client = useClient();
  return useQuery({
    queryKey: factoryKeys.vision(projectId),
    queryFn: () => client.factory.vision(projectId),
  });
}

const MODE_ERRORS: Record<string, string> = {
  not_a_github_project: "The software and dark factory need a GitHub project.",
  vision_required: "Write and save the vision file first.",
  limits_required: "Set the factory limits first.",
  budget_required: "Set a daily budget (dollars or tokens).",
};

/** A readable reason for a refused mode switch. */
export function modeErrorText(error: Error): string {
  if (error instanceof ApiRequestError) return MODE_ERRORS[error.code] ?? error.message;
  return error.message;
}
