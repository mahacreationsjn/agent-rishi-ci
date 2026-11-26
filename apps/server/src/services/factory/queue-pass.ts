import {
  checksPassed,
  type FactoryItem,
  type FactoryLoop,
  type Project,
} from "@agent-rishi/contracts";
import type { FactoryContext } from "./context";
import { type ClashGroup, clashGroups, clashLabel, sharedClashGroup } from "./fast-merge";
import { mayMerge } from "./policy";
import {
  act,
  isRebasing,
  isRetesting,
  isUpdating,
  mergeQueue,
  note,
  type Pass,
  UPDATE_NOTE,
} from "./queue";
import { baseBranchOf } from "./rebase";

/**
 * The merge queue's pass (§10.1, Merge): on every tick, each queued PR that is ready merges or
 * is brought up to date, in the queue's order (`queue.ts` has the order and the step for one PR).
 */

/** Times a pass waits for GitHub to work out the next PR after a merge (`FactoryContext.settle`). */
const SETTLE_WAITS = 3;

/**
 * Whether PRs are re-tested one at a time: under the `strict` policy, while CI on the default
 * branch is red and where branch protection wants PRs up to date, every merge puts the other
 * queued PRs behind again, so re-testing them side by side would run CI on all of them after
 * each merge.
 */
function oneAtATime(ctx: FactoryContext, project: Project, loop: FactoryLoop): boolean {
  return (
    project.factoryLimits.mergePolicy === "strict" ||
    Boolean(loop.fastMergeHold) ||
    ctx.upToDateRequired.has(project.id)
  );
}

/** The ready PRs from `from` on say where they stand in line (among the PRs still queued). */
function waitInLine(ctx: FactoryContext, queue: FactoryItem[], from: number): void {
  let place = 0;
  queue.forEach((queued, n) => {
    const item = ctx.store.item(queued.id) ?? queued;
    if (item.stage !== "verifying") return;
    place++;
    if (n < from || isRebasing(item) || !checksPassed(item)) return;
    note(ctx, item, `Every check passed; queued to merge (number ${place} in line)`);
  });
}

/**
 * One pass over the queue per tick, in the order the PRs merge. Every PR whose checks passed
 * merges, or is brought up to date when it has to be re-tested first; the ones that wait (CI,
 * a re-review, a rebase) are passed over. After a merge, GitHub gets a moment to work out the
 * next PR against the new default branch (`FactoryContext.settle`, a few times per pass), so
 * merges follow each other within seconds; what is still unsettled then merges on the next tick.
 */
export async function advanceQueue(
  ctx: FactoryContext,
  project: Project,
  loop: FactoryLoop,
): Promise<FactoryLoop> {
  const queue = mergeQueue(ctx, project);
  const branch = baseBranchOf(project);
  const pass: Pass = { merges: 0, waits: SETTLE_WAITS, mainCi: "unread" };
  // Earlier PRs that merge soon (ready, or being re-tested), with the clash groups they change:
  // a later PR that changes the same kind of files is tested on top of them, so it waits.
  const ahead: Array<{ item: FactoryItem; groups: Set<ClashGroup> }> = [];
  for (const [n, item] of queue.entries()) {
    if (!item.pr || isRebasing(item)) continue;
    const groups = clashGroups(ctx.prFiles.get(project.id, item.pr.number) ?? []);
    if (!checksPassed(item)) {
      // Waiting on something of its own (a re-review, CI on its author's commits): passed over.
      if (!isRetesting(item)) continue;
      if (isUpdating(item) && !UPDATE_NOTE.test(item.note ?? ""))
        note(ctx, item, `Updating it with ${branch}`);
      if (oneAtATime(ctx, project, loop)) {
        waitInLine(ctx, queue, n + 1);
        break;
      }
      ahead.push({ item, groups });
      continue;
    }
    // A revert repairs the default branch: neither the pause nor the daily merge limit holds
    // it. Reverts come first in the queue, so nothing behind a held PR is one.
    const held =
      item.source === "revert"
        ? null
        : loop.state === "paused"
          ? "Checks passed; waiting while the loop is paused"
          : mayMerge(loop.mergesToday, project.factoryLimits)
            ? null
            : "Checks passed; the daily merge limit is reached";
    if (held) {
      note(ctx, item, held);
      waitInLine(ctx, queue, n + 1);
      break;
    }
    const earlier = ahead.find((a) => sharedClashGroup(a.groups, groups));
    if (earlier) {
      const kind = clashLabel(sharedClashGroup(earlier.groups, groups) as ClashGroup);
      note(
        ctx,
        item,
        `Every check passed; merges after #${earlier.item.pr?.number ?? "?"} (both change ${kind}, so it is tested on top of it)`,
      );
      ahead.push({ item, groups });
      continue;
    }
    let step = await act(ctx, project, loop, item, pass);
    // The merge before it moved the default branch: GitHub needs a moment to work this one out.
    while (step.did === "unsettled" && pass.merges > 0 && pass.waits > 0) {
      pass.waits--;
      await ctx.settle();
      step = await act(ctx, project, step.loop, ctx.store.item(item.id) ?? item, pass);
    }
    loop = step.loop;
    if (step.did === "merged") {
      pass.merges++;
      continue;
    }
    // Still unsettled after a merge: so are the PRs behind it. The next tick carries on.
    if (step.did === "unsettled" && pass.merges > 0) break;
    if (oneAtATime(ctx, project, loop)) {
      waitInLine(ctx, queue, n + 1);
      break;
    }
    if (step.did !== "nothing") ahead.push({ item, groups });
  }
  return loop;
}
