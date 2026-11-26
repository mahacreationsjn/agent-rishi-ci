import type { FactoryItem, FactoryStats } from "@agent-rishi/contracts";
import { localDay } from "./policy";

const DAY_MS = 24 * 60 * 60 * 1000;
const WEEK_MS = 7 * DAY_MS;

/**
 * Nudge on an item whose merge was reverted because CI on the default branch failed after it:
 * when. It stays when the item goes back to its builder after the revert (`revert.ts`), as do the
 * merge's `mergedAt` and `mergePath` until it merges again.
 */
export const REVERTED_AT = "reverted_at";

type RevertFacts = Pick<FactoryItem, "stage" | "finishedAt" | "mergedAt" | "nudges">;

/** When the item's merge was last reverted; null when it never was (older items: when it finished). */
export function revertedAt(item: RevertFacts): string | null {
  return item.nudges[REVERTED_AT] ?? (item.stage === "reverted" ? item.finishedAt : null);
}

/** Whether the item's last merge was reverted (not a merge that came after the revert). */
export function lastMergeReverted(item: RevertFacts): boolean {
  const at = revertedAt(item);
  return at !== null && (item.mergedAt === null || at >= item.mergedAt);
}

/** The middle value (the mean of the two middle ones for an even count); null when empty. */
export function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2
    ? (sorted[mid] as number)
    : ((sorted[mid - 1] as number) + (sorted[mid] as number)) / 2;
}

/**
 * The Factory view's throughput figures (`FactoryStatus.stats`): today's merges, failures and
 * reverts by the server's local day; over the last 7 days, the median time from intake to
 * merge, how the merge queue merged (on their own CI or re-tested against the default branch)
 * and how many fast merges were reverted, so the user can see whether fast merges pay off.
 */
export function factoryStats(items: FactoryItem[], now: Date): FactoryStats {
  const today = localDay(now);
  const on = (at: string | null) => at !== null && localDay(new Date(at)) === today;
  const since = now.getTime() - WEEK_MS;
  const inWeek = (at: string | null) => {
    if (!at) return false;
    const t = Date.parse(at);
    return t >= since && t <= now.getTime();
  };
  const merged7d = items.filter((i) => inWeek(i.mergedAt));
  const durations = merged7d.map((i) =>
    Math.max(0, Date.parse(i.mergedAt as string) - Date.parse(i.createdAt)),
  );
  return {
    mergedToday: items.filter((i) => on(i.mergedAt)).length,
    failedToday: items.filter((i) => i.stage === "failed" && on(i.finishedAt)).length,
    revertedToday: items.filter((i) => on(revertedAt(i))).length,
    medianMergeMs7d: median(durations),
    merged7d: durations.length,
    fastMerges7d: merged7d.filter((i) => i.mergePath === "fast").length,
    retestedMerges7d: merged7d.filter((i) => i.mergePath === "retested").length,
    fastReverts7d: items.filter(
      (i) => i.mergePath === "fast" && lastMergeReverted(i) && inWeek(revertedAt(i)),
    ).length,
  };
}

/** Bounds of `viewRecentItems`, for narrowing the query first (`FactoryStore.viewCandidates`). */
export function viewWindow(now: Date): { failedSince: string; mergedSince: string } {
  const midnight = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  return {
    failedSince: new Date(now.getTime() - DAY_MS).toISOString(),
    mergedSince: midnight.toISOString(),
  };
}

/**
 * The finished items the Factory view keeps showing (`FactoryStatus.viewRecent`), whatever their
 * place in the capped recent list: every escalated item, failed items that failed in the last
 * 24 hours or still own an open pull request (`ownsOpenPr`: their own, or a rebuild's original
 * the factory still holds), and items merged today (by the local day).
 */
export function viewRecentItems(
  items: FactoryItem[],
  now: Date,
  ownsOpenPr: (item: FactoryItem) => boolean,
): FactoryItem[] {
  const today = localDay(now);
  return items.filter((i) => {
    if (i.stage === "escalated") return true;
    if (i.stage === "failed") {
      const at = Date.parse(i.finishedAt ?? i.updatedAt);
      return ownsOpenPr(i) || now.getTime() - at < DAY_MS;
    }
    if (i.stage === "merged")
      return i.mergedAt !== null && localDay(new Date(i.mergedAt)) === today;
    return false;
  });
}
