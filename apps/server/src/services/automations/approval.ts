import { isDeepStrictEqual } from "node:util";
import type { ApprovedAutonomy, Automation, AutonomyLevel } from "@agent-rishi/contracts";

/** The fields that decide what an automation does, when and how often. */
export const BEHAVIOUR_FIELDS = ["trigger", "action", "guards"] as const;

/**
 * Whether `after` does something different from `before` (§10): another trigger, action
 * (prompt, permission level, provider, model, ...) or guards. A new name or description
 * doesn't count. An automation that is on is switched off by such a change unless a person
 * made it, so a person approves what it now does before it runs on its own again.
 */
export function changesBehaviour(
  before: Pick<Automation, (typeof BEHAVIOUR_FIELDS)[number]>,
  after: Pick<Automation, (typeof BEHAVIOUR_FIELDS)[number]>,
): boolean {
  return BEHAVIOUR_FIELDS.some((key) => !isDeepStrictEqual(before[key], after[key]));
}

const RANK: Record<AutonomyLevel, number> = { read_only: 0, supervised: 1, auto: 2, full: 3 };

/** The permission level an automation's sessions ask for (undefined: the project's default). */
export function askedAutonomy(a: Pick<Automation, "action">): AutonomyLevel | undefined {
  if (a.action.type === "start_session") return a.action.autonomy;
  if (a.action.type === "triage") return a.action.policy?.autonomy;
  return undefined;
}

/** The automation as a person approves it by switching it on: what its sessions ask for now. */
export function approved(a: Automation): Automation {
  const level: ApprovedAutonomy = askedAutonomy(a) ?? "default";
  return { ...a, approvedAutonomy: level };
}

/** How a run is started, for its permission ceiling. */
export interface RunApproval {
  /** The level a session gets when it names none: the project's, else the global default. */
  fallback: AutonomyLevel;
  /** Whether the automation is on in the run's project. */
  on: boolean;
  /** A person started it ("Run now" in Automations): it runs as defined. */
  byPerson?: boolean;
}

/**
 * The permission level a run's session is started with (§10): what the automation asks for,
 * but never above the level a person last approved. Undefined leaves it to the project's
 * default. Without a recorded approval, an automation that is on runs as defined (it was
 * switched on before approvals were recorded, and any change to what it does since switches it
 * off) and one that is off gets no more than the project's default, like any session a PM starts.
 */
export function runAutonomy(a: Automation, run: RunApproval): AutonomyLevel | undefined {
  const asked = askedAutonomy(a);
  if (run.byPerson) return asked;
  const ceiling = a.approvedAutonomy ?? (run.on ? undefined : "default");
  if (ceiling === undefined) return asked;
  const max = ceiling === "default" ? run.fallback : ceiling;
  if (RANK[asked ?? run.fallback] <= RANK[max]) return asked;
  return ceiling === "default" ? undefined : ceiling;
}
