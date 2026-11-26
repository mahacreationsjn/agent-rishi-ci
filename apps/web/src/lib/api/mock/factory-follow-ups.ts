import type {
  FactoryStatus,
  FactoryWorkItem,
  HeldFollowUp,
  ReviewFollowUp,
} from "@agent-rishi/contracts";

/**
 * The mock dark factory's review follow-ups held for the scout (#435): the low-severity
 * follow-up of the first two merged items waits for a round, with File now and Dismiss.
 */
export function demoHeldFollowUps(
  recent: FactoryWorkItem[],
  followUp: ReviewFollowUp | undefined,
): HeldFollowUp[] {
  if (!followUp) return [];
  return recent
    .filter((w) => w.mergedAt)
    .slice(0, 2)
    .map((w) => ({
      id: `fu-${w.id.slice(0, 8)}-2`,
      title: followUp.title,
      severity: followUp.severity ?? null,
      area: followUp.area ?? null,
      itemId: w.id,
      index: 1,
      itemTitle: w.title,
      pr: w.pr,
      heldAt: w.mergedAt as string,
    }));
}

/** The status with one follow-up off the scout's held list (filed or dismissed). */
export function withoutHeld(s: FactoryStatus, itemId: string, index: number): FactoryStatus {
  if (!s.scout) return s;
  const heldFollowUps = s.scout.heldFollowUps.filter(
    (h) => h.itemId !== itemId || h.index !== index,
  );
  return { ...s, scout: { ...s.scout, heldFollowUps } };
}
