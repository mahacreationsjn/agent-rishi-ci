import type { FactoryItem, Project } from "@agent-rishi/contracts";
import { errorMessage } from "../errors";
import { failedChecks } from "./checks";
import { letGoReviewer } from "./cleanup";
import { baseBranchOf, type FactoryContext } from "./context";
import type { FactoryPr } from "./github-port";
import { closeInboxFor, githubRefused } from "./merge";
import { repairsMain } from "./overlap";
import { MAIN_RED, trackedHead, UPDATE } from "./rebase";
import { endedByStop } from "./stops";

/**
 * Red CI that is the default branch's (§10.1, Review and revise). While CI on the default
 * branch is red, every PR's CI runs on top of it and fails the same checks. A PR whose CI fails
 * only checks that also fail there hasn't failed on its own: its `ci` check waits for the
 * branch (pending: no revise round, no failure counted), and the merge queue passes over it.
 * Once CI on the branch is green again, the PR is brought up to date (GitHub's update-branch, no
 * agent) so its CI runs on the fixed branch, and it is judged as usual. A PR that fails a check
 * the branch passes is its own failure, as before. So is red CI on a repair of the branch (a
 * revert, a fix for its failed checks, `repairsMain`): it hasn't repaired it yet.
 *
 * Checks are compared by name. A PR that breaks a test of its own inside a check the branch also
 * fails waits for the branch all the same, and is judged on its re-run once the branch is green.
 *
 * Work that failed on such CI before the factory waited for the branch goes back to verification
 * once CI on the branch is green, when CI there was red on the same checks as it failed.
 */

/** Failures further back than this stay with a person. */
export const RESTORE_WINDOW_MS = 7 * 24 * 60 * 60_000;

/** `main_red_checked`: the failure (its `finishedAt`) already compared with the default branch. */
const CHECKED = "main_red_checked";

/** Whether the PR fails checks, and only ones that also fail on the default branch. */
export function failsOnlyWhatMainFails(
  prFailed: readonly string[],
  mainFailed: readonly string[],
): boolean {
  return prFailed.length > 0 && prFailed.every((name) => mainFailed.includes(name));
}

function names(list: readonly string[], max = 5): string {
  return list.length > max
    ? `${list.slice(0, max).join(", ")} and ${list.length - max} more`
    : list.join(", ");
}

/**
 * Whether the item's PR waits for the default branch: its head's red CI is the branch's, and it
 * isn't being brought up to date yet. The merge queue passes over it, so it never holds up the
 * PRs behind it, one of which may be the fix.
 */
export function waitsForMain(item: Pick<FactoryItem, "nudges">): boolean {
  const head = trackedHead(item);
  return (
    head !== null && Boolean(item.nudges[`${MAIN_RED}${head}`]) && !item.nudges[`${UPDATE}${head}`]
  );
}

/**
 * The `ci` check's pending detail when the PR's red CI is the default branch's; null when its CI
 * is judged as usual. The PR's head is marked (`main_red_<sha>`) the first time, so it keeps
 * waiting while CI on the branch runs, and it is brought up to date once the branch no longer
 * fails what it failed.
 */
export async function inheritedCi(
  ctx: FactoryContext,
  project: Project,
  item: FactoryItem,
  pr: FactoryPr,
): Promise<string | null> {
  const head = pr.headSha;
  // A repair of the branch (a revert, a fix for its failed checks) red on the branch's checks
  // hasn't repaired it: that CI is its own failure, so a fix gets its revise rounds.
  if (pr.checks !== "failure" || !head || repairsMain(item)) return null;
  const branch = baseBranchOf(project);
  const key = `${MAIN_RED}${head}`;
  const main = await ctx.mainCi.view(ctx.github, project.id);
  if (main?.state === "red" && failsOnlyWhatMainFails(pr.failedChecks, main.head.failed)) {
    if (!item.nudges[key]) {
      const at = ctx.now().toISOString();
      ctx.store.updateItem(item.id, (i) => ({ ...i, nudges: { ...i.nudges, [key]: at } }));
      ctx.log?.(`factory: ${item.id}: #${pr.ref.number} fails only what fails on ${branch}`);
    }
    return `CI on ${branch} is red (${names(main.head.failed)} on ${main.head.sha.slice(0, 7)}), and this PR fails only those checks: waiting for ${branch} to be green again`;
  }
  if (!item.nudges[key]) return null;
  if (!main) return `Could not read CI on ${branch}; trying again on the next check`;
  if (main.state === "running")
    return `CI on ${branch} is running after it was red; this PR's CI is judged once it is green`;
  // The branch no longer fails what this PR failed: its CI runs again on top of the branch.
  if (pr.mergeable === "conflicting")
    return `CI on ${branch} is green again: the PR's merge conflicts are resolved first, then CI runs on the new head`;
  return updateWithMain(ctx, project, item, pr.ref.number, head);
}

/**
 * Bring the waiting PR up to date with the default branch (update-branch, head pinned, no
 * agent); CI then runs on the new head. A refusal (up to date already, a new head) leaves its
 * CI to be judged as usual; GitHub not answering is tried again on the next check.
 */
async function updateWithMain(
  ctx: FactoryContext,
  project: Project,
  item: FactoryItem,
  number: number,
  head: string,
): Promise<string | null> {
  const branch = baseBranchOf(project);
  const updating = `CI on ${branch} is green again: updating this PR with ${branch}, then CI runs on the new head`;
  const key = `${UPDATE}${head}`;
  const asked = item.nudges[key];
  // GitHub makes the new head in the background; asked again if none came within the CI grace.
  if (asked && ctx.now().getTime() - Date.parse(asked) < ctx.ciGraceMs) return updating;
  try {
    await ctx.github.updateBranch(project.id, number, head);
  } catch (error) {
    if (githubRefused(error)) return null;
    const why = errorMessage(error).replace(/[.\s]+$/, "");
    return `Could not update it with ${branch}: ${why}; trying again on the next check`;
  }
  const at = ctx.now().toISOString();
  ctx.store.updateItem(item.id, (i) => ({ ...i, nudges: { ...i.nudges, [key]: at } }));
  return updating;
}

/** Stopped on its merge checks with red CI its only failed check. */
function failedOnCiOnly(item: FactoryItem): boolean {
  if (item.failureKind !== "checks" || item.review?.verdict === "reject") return false;
  // Stopped on purpose (`stops.ts`): only a Retry runs it again.
  if (endedByStop(item)) return false;
  const failed = failedChecks(item.checks);
  return (
    failed.length === 1 &&
    failed[0]?.name === "ci" &&
    (failed[0].detail ?? "").startsWith("CI failed")
  );
}

/**
 * A failed item (`ownership`, `owned.ts`) whose only failed check was red CI goes back to
 * verification once CI on the default branch is green, when the branch's head as the item failed
 * (read from GitHub) was red on every check its PR fails. Its head is marked as waiting for the
 * branch, so the verify step brings it up to date and judges it on the fixed branch. Compared
 * once per failure, within `RESTORE_WINDOW_MS`, and not while the loop holds agent turns
 * (`holds`: paused or draining). True when it went back.
 */
export async function restoreInherited(
  ctx: FactoryContext,
  project: Project,
  item: FactoryItem,
  pr: FactoryPr,
  holds: boolean,
): Promise<boolean> {
  const finished = item.finishedAt;
  const head = pr.headSha;
  if (holds || !finished || !head || item.nudges[CHECKED] === finished) return false;
  // A repair of the branch put back after the branch was fixed would only re-test a fix no
  // longer needed.
  if (repairsMain(item) || !failedOnCiOnly(item) || pr.checks !== "failure") return false;
  if (ctx.now().getTime() - Date.parse(finished) > RESTORE_WINDOW_MS) return false;
  const main = await ctx.mainCi.view(ctx.github, project.id);
  if (main?.state !== "green") return false;
  let then: Awaited<ReturnType<typeof ctx.github.mainHeadAt>>;
  try {
    then = await ctx.github.mainHeadAt(project.id, finished);
  } catch (error) {
    ctx.log?.(
      `factory: ${item.id}: reading the default branch's head then: ${errorMessage(error)}`,
    );
    return false;
  }
  // Its head then was green, or red on other checks: the failure was its own.
  if (then?.checks !== "failure" || !failsOnlyWhatMainFails(pr.failedChecks, then.failed)) {
    const nudge = (i: FactoryItem) => ({ ...i, nudges: { ...i.nudges, [CHECKED]: finished } });
    ctx.store.updateItem(item.id, nudge, { touch: false });
    return false;
  }
  const branch = baseBranchOf(project);
  const at = ctx.now().toISOString();
  const reviewer = item.reviewerSessionId
    ? ctx.repo.find(item.reviewerSessionId)?.session
    : undefined;
  const reviewerGone =
    Boolean(item.reviewerSessionId) && (!reviewer || reviewer.status === "failed");
  ctx.store.updateItem(item.id, (i) => ({
    ...i,
    stage: "verifying",
    reason: null,
    failureKind: null,
    finishedAt: null,
    // Cleanup archived its sessions; they are needed again (a message brings them back).
    sessionsArchivedAt: null,
    ...(reviewerGone ? letGoReviewer(i) : {}),
    note: `Back in verification: its CI failed only on checks that were red on ${branch} too (${names(then.failed)}); re-tested now that ${branch} is green`,
    nudges: { ...i.nudges, [CHECKED]: finished, [`${MAIN_RED}${head}`]: at, verifying: at },
  }));
  closeInboxFor(ctx, item.id, "Back in verification: its CI failure was the default branch's");
  ctx.log?.(
    `factory: ${item.id}: back in verification (#${pr.ref.number} failed on red ${branch})`,
  );
  return true;
}
