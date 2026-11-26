import {
  type FactorySpotChecks,
  SPOT_CHECK_WINDOW_DAYS,
  type SpotCheckReason,
  type SpotCheckState,
  spotCheckProblemPercent,
} from "@agent-rishi/contracts";

/**
 * Spot-checks as the factory panel and the item page word them (§10.1): why a merge was set aside,
 * what a person found, the share in force and the share of checks that found a problem.
 */

/**
 * The Spot-checks card's anchor on the project page: `/projects/<id>#spot-checks` (the inbox's
 * Open spot-checks) opens the page scrolled to the card, open.
 */
export const SPOT_CHECKS_ANCHOR = "spot-checks";

/** Why a merge was set aside, in a few words. */
export const SPOT_CHECK_REASON: Record<SpotCheckReason, { label: string; title: string }> = {
  sampled: {
    label: "Sampled",
    title: "Picked by the share of automatic merges set aside for a person's look",
  },
  untrusted_author: {
    label: "Untrusted author",
    title: "Its issue came from an untrusted author and was let in by hand: always checked",
  },
  large_change: {
    label: "Large change",
    title: "It was allowed past the size limit: always checked",
  },
};

/** What a person found. */
export const SPOT_CHECK_STATE: Record<SpotCheckState, string> = {
  pending: "Waiting for a look",
  looks_good: "Looks good",
  problem: "Found a problem",
};

/** "10% of automatic merges, plus untrusted-author work and large changes", or that it is off. */
export function spotCheckShareText(percent: number): string {
  if (percent === 0) return "Off: no merge is set aside";
  return `${percent}% of automatic merges, plus untrusted-author work and large changes`;
}

/** "A person found a problem in 1 of 7 checked merges (14%) over 30 days". */
export function spotCheckProblemText(s: Pick<FactorySpotChecks, "checked30d" | "problems30d">) {
  const share = spotCheckProblemPercent(s.checked30d, s.problems30d);
  if (share === null) return `None checked in the last ${SPOT_CHECK_WINDOW_DAYS} days`;
  const merges = `${s.checked30d} checked merge${s.checked30d === 1 ? "" : "s"}`;
  return `A person found a problem in ${s.problems30d} of ${merges} (${share}%) over ${SPOT_CHECK_WINDOW_DAYS} days`;
}

/** Whether the panel shows the card: spot-checks are on, or there is something to show. */
export function showSpotChecks(s: FactorySpotChecks): boolean {
  return s.percent > 0 || s.pending.length > 0 || s.recent.length > 0;
}
