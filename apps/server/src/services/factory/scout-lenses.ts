import type {
  DiscoveryArea,
  Project,
  ScoutLensRequest,
  ScoutState,
  Session,
} from "@agent-rishi/contracts";
import { errorMessage } from "../errors";
import { needsFreshSession, type ScoutAgent } from "./agent-choice";
import type { FactoryContext } from "./context";
import { wakeForRoundInBackground } from "./scout-compact";
import { isBusy } from "./sessions";
import { claimSlot, SCOUT_SLOT } from "./slots";

/**
 * Starting the area reviewers the scout planned (§10.1). `factory_plan_round` only records the
 * plan; the loop starts the reviewers here, on its passes, as agent slots free up.
 */

/**
 * How long a round waits for its area reviewers: those that haven't started this long after the
 * scout planned never do (a round none started closes), and a round whose scout ended its turn
 * without planning closes once it has sat unplanned this long (the loop couldn't act on it).
 */
export const LENS_START_TIMEOUT_MS = 15 * 60_000;

/** The brief for one area reviewer (`firstRun`: a new session, not one woken again). */
export type LensBrief = (lens: ScoutLensRequest, firstRun: boolean) => string;

/**
 * Start or wake the planned area reviewers that get a free agent (the scout's come after all
 * other work waiting for one, `slots.ts`). A new reviewer's session starts in the background; an
 * idle one is woken without waiting, since that may resume it on the runner (recreating its
 * worktree first), which can take minutes under load. The round reviews once one has started.
 * Those not started `LENS_START_TIMEOUT_MS` after the plan are dropped. `closed` says why the
 * round closes when none started and none will, so the next round is scheduled instead of this
 * one sitting until its timeout.
 */
export async function startPlannedLenses(
  ctx: FactoryContext,
  project: Project,
  scout: ScoutState,
  now: Date,
  brief: LensBrief,
  /** Where area reviewers run (`scoutProvider`, `scoutModel`). */
  agent: ScoutAgent,
): Promise<{ scout: ScoutState; closed: string | null }> {
  const round = scout.round;
  const plan = round?.plan;
  if (!round || !plan) return { scout, closed: null };
  const at = now.toISOString();
  const lensSessions = { ...scout.lensSessions };
  const lenses = [...round.lenses];
  const waiting: DiscoveryArea[] = [];
  const failed: DiscoveryArea[] = [];
  for (const lens of plan.lenses.filter((l) => plan.pending.includes(l.area))) {
    const { reuse, replaces } = scoutSessionPlan(ctx, lensSessions[lens.area], agent);
    if (!claimSlot(ctx, project, "scout", SCOUT_SLOT, { wake: reuse?.id })) {
      waiting.push(lens.area);
      continue;
    }
    retireScoutSession(ctx, replaces);
    const text = brief(lens, !reuse);
    const sessionId = await startLens(ctx, project.id, lens.area, text, reuse, agent.choice);
    if (!sessionId) {
      failed.push(lens.area);
      continue;
    }
    lensSessions[lens.area] = sessionId;
    lenses.push({ ...lens, sessionId, sentAt: at, reported: false, nudgedAt: null });
  }
  const late = now.getTime() - Date.parse(plan.at) > LENS_START_TIMEOUT_MS;
  const dropped = late ? waiting : [];
  if (dropped.length > 0) {
    ctx.log?.(`factory: area reviewers ${dropped.join(", ")}: no free agent within 15 minutes`);
  }
  const next = { ...scout, lensSessions };
  if (lenses.length === 0 && (late || waiting.length === 0)) {
    const areas = [...failed, ...dropped].join(", ");
    const why = late ? "no free agent within 15 minutes" : "their sessions failed to start";
    return { scout: next, closed: `Closed: couldn't start area reviewers (${areas}): ${why}.` };
  }
  const phase = lenses.length > 0 ? "reviewing" : round.phase;
  const pending = late ? [] : waiting;
  return {
    scout: { ...next, round: { ...round, phase, lenses, plan: { ...plan, pending } } },
    closed: null,
  };
}

/** What happens to the scout's or an area reviewer's long-lived session this round. */
export interface ScoutSessionPlan {
  /** The session to wake with the round's brief; none: a fresh session starts. */
  reuse: Session | undefined;
  /** A session a fresh one replaces, archived once the round has an agent (`retireScoutSession`). */
  replaces: Session | undefined;
}

/**
 * The scout's or an area reviewer's long-lived session to use again this round, if any. One that
 * no longer runs where the settings ask (`needsFreshSession`: they name another provider or
 * model) is replaced by a fresh session on the chosen provider and model. A busy one (a person
 * messaged it) is used once more and replaced at a later round that finds it idle, so it is never
 * left running and unarchived.
 */
export function scoutSessionPlan(
  ctx: FactoryContext,
  sessionId: string | null | undefined,
  agent: ScoutAgent,
): ScoutSessionPlan {
  const session = ctx.sessions.reusable(sessionId);
  const models = session ? ctx.sessions.models(session.provider) : [];
  if (!session || isBusy(session) || !needsFreshSession(session, agent, models)) {
    return { reuse: session, replaces: undefined };
  }
  return { reuse: undefined, replaces: session };
}

/** Archive the session a fresh one replaces (`ScoutSessionPlan.replaces`), if any. */
export function retireScoutSession(ctx: FactoryContext, session: Session | undefined): void {
  if (!session) return;
  const was = `${session.provider}${session.model ? ` (${session.model})` : ""}`;
  ctx.log?.(`factory: ${session.title ?? session.id} ran on ${was}; a fresh session replaces it`);
  ctx.archiveSessions([session.id]);
}

/**
 * Start a new area reviewer, or wake the idle one (not awaited; compacted first when its context
 * has grown, `scout-compact.ts`); its session id, or null.
 */
async function startLens(
  ctx: FactoryContext,
  projectId: string,
  area: DiscoveryArea,
  text: string,
  reuse: Session | undefined,
  choice: ScoutAgent["choice"],
): Promise<string | null> {
  try {
    if (reuse) {
      wakeForRoundInBackground(ctx, reuse, text, `area reviewer ${area}`);
      return reuse.id;
    }
    if ("waiting" in choice) {
      ctx.log?.(`factory: area reviewer ${area}: ${choice.waiting}`);
      return null;
    }
    const res = await ctx.sessions.startLens(projectId, area, text, choice);
    return res.status === "started" || res.status === "queued" ? res.sessionId : null;
  } catch (error) {
    ctx.log?.(`factory: area reviewer ${area}: ${errorMessage(error)}`);
    return null;
  }
}
