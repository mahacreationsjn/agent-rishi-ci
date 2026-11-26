import type { FactoryItem, FactoryLoop, Project, Session } from "@agent-rishi/contracts";
import { errorMessage } from "../errors";
import { type AgentChoice, type AgentWait, builderWanted, chooseAgent } from "./agent-choice";
import { baseBranchOf, type FactoryContext } from "./context";
import { revertBlocked, revertedName } from "./revert-blocked";
import { claimSlot } from "./slots";

/**
 * Starting the agent that writes an automatic revert (§10.1, Merge), when the revert couldn't be
 * opened through the API. Its provider and model are chosen as a bug's builder's are
 * (`builderProvider`/`builderModel`, `chooseAgent`): a provider the factory backed off (signed
 * out, at its usage limit, a CLI too old, or one that just refused this revert's session) is
 * skipped for another available one, and while no provider is available the revert waits in the
 * queue without counting a failed start. A start that fails (no agent could start, the runner
 * timed out opening the session, or the session failed or is gone before it opened the PR) never
 * drops the revert or fails it for good: it goes back to the queue (`backlog`, its earlier
 * session let go) and starts again from the next tick, also while the regression pauses the
 * loop, on the first free agent ahead of all other work (the `revert` slot tier, `slots.ts`).
 * After `MAX_REVERT_STARTS` failed starts the user hears it once: the regression's inbox item
 * says the revert couldn't start and why, and the revert fails as stuck, so Retry starts it again.
 *
 * Nudges on the revert item: `revert_start_failed_<n>` (its n-th start failed).
 */

export const MAX_REVERT_STARTS = 3;

const FAILED_START = "revert_start_failed_";
const REQUEUED = "The revert couldn't start";

/** How many starts of the revert's agent failed so far. */
export function failedRevertStarts(item: FactoryItem): number {
  let n = 0;
  while (item.nudges[`${FAILED_START}${n + 1}`]) n++;
  return n;
}

/** The merge a revert undoes, as `startRevert` takes it; null when it isn't on record. */
function mergeOf(ctx: FactoryContext, revert: FactoryItem) {
  const original = revert.revertOf ? ctx.store.item(revert.revertOf) : undefined;
  if (!original?.mergeSha) return null;
  return { sha: original.mergeSha, prNumber: original.pr?.number ?? 0, title: original.title };
}

/**
 * Where the agent writing a revert starts: the builder's provider and model for a bug, else
 * another available provider; with none available, the note to show while it waits.
 */
export function revertAgent(
  ctx: FactoryContext,
  project: Project,
  loop: FactoryLoop,
): AgentChoice | AgentWait {
  return chooseAgent(ctx, project, builderWanted({ type: "bug" }, loop.tuning), "revert");
}

/** A started revert agent: its session and the provider it runs on (null: not known). */
export interface StartedRevert {
  sessionId: string;
  provider: string | null;
}

/** Start the agent writing the revert on `agent` (`revertAgent`): its session, or why none started. */
export async function startRevertAgent(
  ctx: FactoryContext,
  projectId: string,
  merge: { sha: string; prNumber: number; title: string },
  agent: AgentChoice,
): Promise<StartedRevert | { why: string }> {
  try {
    const res = await ctx.sessions.startRevert(projectId, merge, agent);
    if (res.status !== "started")
      return { why: `no agent could start to write it (${res.status})` };
    const session = ctx.repo.find(res.sessionId)?.session;
    const chosen = agent.provider === "auto" ? null : agent.provider;
    return { sessionId: res.sessionId, provider: session?.provider ?? chosen };
  } catch (error) {
    return { why: errorMessage(error) };
  }
}

/** Why a revert's session failed: the runner's report of a refused open, or the launcher's. */
export function revertSessionFailure(ctx: FactoryContext, s: Session): string {
  const why = s.startError?.message ?? ctx.inbox.find(`inbox:${s.id}:start`)?.body;
  return why ? why.slice(0, 200) : "its session failed";
}

/**
 * A start of the revert's agent failed (`why`): back to the queue with the try counted, ahead of
 * all other work. After `MAX_REVERT_STARTS` tries, one clear inbox item, and the revert fails as
 * stuck with the loop paused for a person.
 */
export async function revertStartFailed(
  ctx: FactoryContext,
  project: Project,
  loop: FactoryLoop,
  item: FactoryItem,
  why: string,
): Promise<FactoryLoop> {
  const n = failedRevertStarts(item) + 1;
  const at = ctx.now().toISOString();
  const earlier = item.builderSessionId;
  const requeued = ctx.store.updateItem(item.id, (i) => {
    // The earlier attempt's reminders would stop the fresh agent at once.
    const { builder_no_pr: _asked, builder_investigate: _step, ...nudges } = i.nudges;
    return {
      ...i,
      stage: "backlog",
      builderSessionId: null,
      builderProvider: null,
      reason: null,
      failureKind: null,
      finishedAt: null,
      note: `${REQUEUED} (${why}): it starts again on the next free agent, ahead of all other work`,
      nudges: { ...nudges, [`${FAILED_START}${n}`]: at },
      earlierSessionIds: earlier
        ? [...new Set([...i.earlierSessionIds, earlier])]
        : i.earlierSessionIds,
    };
  });
  ctx.log?.(
    `factory: ${item.id}: the revert couldn't start (${n} of ${MAX_REVERT_STARTS}): ${why}`,
  );
  if (n < MAX_REVERT_STARTS) return loop;
  const branch = baseBranchOf(project);
  const merged = revertedName(ctx, item);
  return revertBlocked(ctx, project, loop, requeued, why, {
    title: `${branch} is red and the revert of ${merged} couldn't start: ${why}`,
    body: `CI on ${branch} failed after ${merged} merged, and the agent writing its automatic revert couldn't start (${MAX_REVERT_STARTS} tries): ${why}. The factory loop stays paused: Retry the revert, or fix ${branch} by hand (revert ${merged} yourself) and resume the loop.`,
  });
}

/**
 * Queued reverts start, oldest first, each on the first free agent and ahead of all other work.
 * Runs on every tick before anything else claims an agent, also while the loop is paused or
 * draining: the default branch stays red until the revert lands. While no provider is available
 * a revert waits with its note, holding no slot and counting no failed start.
 */
export async function startQueuedReverts(
  ctx: FactoryContext,
  project: Project,
  loop: FactoryLoop,
): Promise<FactoryLoop> {
  let next = loop;
  const queued = ctx.store
    .items(project.id, ["backlog"])
    .filter((i) => i.source === "revert")
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  for (const item of queued) {
    const merge = mergeOf(ctx, item);
    if (!merge) {
      next = await revertBlocked(ctx, project, next, item, "the merge it reverts isn't on record");
      continue;
    }
    const agent = revertAgent(ctx, project, next);
    if ("waiting" in agent) {
      if (item.note !== agent.waiting)
        ctx.store.updateItem(item.id, (i) => ({ ...i, note: agent.waiting }), { touch: false });
      continue;
    }
    if (!claimSlot(ctx, project, "revert", `revert:${item.id}`)) {
      const note = "Waiting for a free agent: the revert starts first";
      ctx.store.updateItem(item.id, (i) => (i.note?.startsWith(REQUEUED) ? i : { ...i, note }), {
        touch: false,
      });
      continue;
    }
    const started = await startRevertAgent(ctx, project.id, merge, agent);
    if ("why" in started) {
      next = await revertStartFailed(ctx, project, next, item, started.why);
      continue;
    }
    ctx.store.updateItem(item.id, (i) => ({
      ...i,
      stage: "building",
      builderSessionId: started.sessionId,
      builderProvider: started.provider,
      note: "An agent is writing the revert",
    }));
  }
  return next;
}
