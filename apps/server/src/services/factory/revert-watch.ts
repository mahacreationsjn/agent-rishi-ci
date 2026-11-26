import type { FactoryItem, FactoryLoop, Project } from "@agent-rishi/contracts";
import { baseBranchOf, type FactoryContext, pauseLoop, raiseInbox } from "./context";
import { regressionInboxId } from "./revert-blocked";

/**
 * CI on the default branch after an automatic revert merged (§10.1, Merge). Only a green run on
 * the revert's merge commit ends the regression by itself (`revertLanded`); until then the loop
 * stays paused, and the user always hears why:
 * - no report in time (no CI after `ciGraceMs`, or still running after `watchTimeoutMin`): the
 *   commit's CI is read once more after another `ciGraceMs`; still nothing, and the regression's
 *   inbox item becomes "<branch> is red or unverified after revert #N: CI didn't report". The
 *   revert stays watched, so a late green still resumes the loop and sends the work back;
 * - red: the revert is done, and the regression's inbox item becomes "<branch> is still red after
 *   revert #N". Either way the user resumes the loop once the branch is green (`revertsOnResume`).
 *
 * Nudges on the revert item: `main_ci_recheck` (CI hadn't reported in time: read once more) and
 * `main_ci_unverified` (still nothing after that: the user was asked).
 */

const RECHECK = "main_ci_recheck";
const UNVERIFIED = "main_ci_unverified";

/** A revert whose CI on the default branch never reported, so the user was asked to look. */
export function unverifiedRevert(item: FactoryItem): boolean {
  return item.source === "revert" && item.stage === "watching" && Boolean(item.nudges[UNVERIFIED]);
}

/**
 * CI on the default branch hasn't passed or failed on a merged revert (`none` or `pending`):
 * wait, read it once more, then tell the user and keep watching. `age` is the time since the merge.
 */
export function awaitRevertCi(
  ctx: FactoryContext,
  project: Project,
  loop: FactoryLoop,
  item: FactoryItem,
  state: "none" | "pending",
  age: number,
): FactoryLoop {
  // A run that started counts again from the merge: it gets the usual time to finish.
  const bound = state === "none" ? ctx.ciGraceMs : loop.tuning.watchTimeoutMin * 60_000;
  if (age <= bound || item.nudges[UNVERIFIED]) return loop;
  const branch = baseBranchOf(project);
  const now = ctx.now();
  const recheck = item.nudges[RECHECK];
  if (!recheck) {
    ctx.store.updateItem(item.id, (i) => ({
      ...i,
      note: `CI on ${branch} hasn't reported on the revert's merge commit yet: checking once more`,
      nudges: { ...i.nudges, [RECHECK]: now.toISOString() },
    }));
    return loop;
  }
  if (now.getTime() - Date.parse(recheck) <= ctx.ciGraceMs) return loop;
  const didnt = state === "none" ? "didn't report" : "didn't finish";
  const revert = revertName(item);
  const sha = (item.mergeSha ?? "").slice(0, 7);
  raiseRevertInbox(ctx, project, item, {
    title: `${branch} is red or unverified after ${revert}: CI ${didnt}`,
    body: `CI on ${branch} failed after ${mergedName(ctx, item)} merged. The automatic ${revert} merged (${sha}), but CI on ${branch} ${didnt} on its merge commit, also after a second look. The factory loop stays paused: check CI on ${branch} (re-run it, or fix its workflow), and resume the loop once ${branch} is green; the reverted work then goes back to its builder. A green run on ${sha} resumes it by itself.`,
  });
  ctx.store.updateItem(item.id, (i) => ({
    ...i,
    note: `CI on ${branch} ${didnt} on the revert's merge commit: the user was asked to look; a green run still resumes the loop`,
    nudges: { ...i.nudges, [UNVERIFIED]: now.toISOString() },
  }));
  return loop;
}

/**
 * CI on the default branch fails on a merged revert's commit too: the revert didn't fix it. The
 * revert is done, the regression's inbox item says the branch is still red, and the loop stays
 * paused for a person (`next` is the loop with the failure counted).
 */
export async function revertStillRed(
  ctx: FactoryContext,
  project: Project,
  next: FactoryLoop,
  item: FactoryItem,
): Promise<FactoryLoop> {
  const branch = baseBranchOf(project);
  const revert = revertName(item);
  const sha = item.mergeSha ?? "";
  const failed = sha ? await ctx.github.failedChecks(project.id, sha).catch(() => []) : [];
  const names = failed.length ? ` (${failed.join(", ").slice(0, 200)})` : "";
  ctx.store.updateItem(item.id, (i) => ({
    ...i,
    stage: "merged",
    note: `CI still fails after the revert${names}`,
    finishedAt: ctx.now().toISOString(),
  }));
  raiseRevertInbox(ctx, project, item, {
    title: `${branch} is still red after ${revert}: CI fails on its merge commit${names}`,
    body: `CI on ${branch} failed after ${mergedName(ctx, item)} merged, and it still fails after the automatic ${revert} merged (${sha.slice(0, 7)}): the revert didn't fix it. The factory loop stays paused: get ${branch} green, then resume the loop; the reverted work then goes back to its builder.`,
  });
  return pauseLoop(ctx, next, `CI on ${branch} still fails after the automatic ${revert}`, {
    inbox: false,
  });
}

/** The regression's one inbox item (raised when the revert opened), now about the revert's merge. */
function raiseRevertInbox(
  ctx: FactoryContext,
  project: Project,
  item: FactoryItem,
  text: { title: string; body: string },
): void {
  raiseInbox(ctx, {
    id: regressionInboxId(item.revertOf ?? item.id),
    kind: "run_failed",
    notify: "failure",
    priority: "high",
    projectId: project.id,
    issue: item.issue,
    pr: item.pr,
    ...text,
  });
}

function revertName(item: FactoryItem): string {
  return item.pr ? `revert #${item.pr.number}` : "revert";
}

/** "#42", the merge the revert undid. */
function mergedName(ctx: FactoryContext, revert: FactoryItem): string {
  const original = revert.revertOf ? ctx.store.item(revert.revertOf) : undefined;
  return original?.pr ? `#${original.pr.number}` : "the merge";
}
