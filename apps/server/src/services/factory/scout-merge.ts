import type { ScoutState } from "@agent-rishi/contracts";

/**
 * The scout's and its area reviewers' reports (`factory_plan_round`, `factory_report_findings`,
 * `factory_file_issue`) are written at once, never behind the loop's ticks, so a tool call
 * answers even while a slow tick runs (§10.1). A tick holds the loop it read when it started,
 * so every save keeps what the reports recorded in the same round since: the plan, the findings,
 * which area reviewers reported, and how many issues were filed. Each only ever grows within a
 * round, so keeping them can't undo anything a tick decided; a round that ended or changed keeps
 * nothing of the old one.
 */
export function keepScoutReports(next: ScoutState, stored: ScoutState | undefined): ScoutState {
  const round = next.round;
  const reported = stored?.round;
  if (!round || !reported || round.id !== reported.id) return next;
  const known = new Set(round.findings.map((f) => f.id));
  const findings = [...round.findings, ...reported.findings.filter((f) => !known.has(f.id))];
  const done = new Set(reported.lenses.filter((l) => l.reported).map((l) => l.sessionId));
  const lenses = round.lenses.map((l) =>
    !l.reported && done.has(l.sessionId) ? { ...l, reported: true } : l,
  );
  const filed = Math.max(round.filed, reported.filed);
  // The plan, with the phase and the scout's last message it set, unless the save has it.
  const planned =
    !round.plan && reported.plan
      ? {
          plan: reported.plan,
          phase: reported.phase,
          sentAt: later(round.sentAt, reported.sentAt),
        }
      : {};
  return { ...next, round: { ...round, ...planned, findings, lenses, filed } };
}

/** The later of two timestamps. */
function later(a: string, b: string): string {
  return Date.parse(a) >= Date.parse(b) ? a : b;
}
