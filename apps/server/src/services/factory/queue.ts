import {
  type FactoryItem,
  type FactoryLoop,
  isFactoryMode,
  type Project,
} from "@agent-rishi/contracts";
import { errorMessage } from "../errors";
import { approvalCovers } from "./approval";
import { CONFLICTS_DETAIL } from "./checks";
import type { FactoryContext } from "./context";
import { fastMergeVerdict, noteProtectionForcesStrict, withMainCi } from "./fast-merge";
import type { FactoryPr, MainSince } from "./github-port";
import { waitsForMain } from "./inherited-ci";
import { autoMerge, githubRefused, type MergeFailed, prDecidedOutside } from "./merge";
import { markStuck } from "./outcomes";
import {
  baseBranchOf,
  QUEUE_UPDATED,
  REFUSED,
  rebaseAsks,
  STRICT,
  trackedHead,
  UPDATE,
} from "./rebase";
import { mayAutoMerge } from "./trust";

/**
 * The merge queue (§10.1, Merge). With auto-merge on, work whose checks all passed joins the
 * queue, and on every tick the factory merges each queued PR that is ready, oldest approved
 * first (reverts ahead of everything), seconds apart.
 *
 * A PR that is behind the default branch merges on its own green CI whenever GitHub can merge
 * it (the `fast` merge policy, `fast-merge.ts`): GitHub reports conflicts, and CI on the
 * default branch is watched after every merge. It is re-tested first (brought up to date with
 * GitHub's `update-branch`, no agent; CI awaited on the new head) only when it and the commits
 * it is missing both changed dependency files or migrations, while CI on the default branch is
 * red, when branch protection wants it up to date, and always under the `strict` policy.
 *
 * A PR that waits (for CI on a new head, for a re-review, for its rebase) never holds up the
 * ready ones behind it. Re-tests run side by side, except where each merge would send the
 * others round again (the `strict` policy, a red default branch, branch protection): there one
 * PR is re-tested at a time. A PR that changes the same kind of clashing files as an earlier
 * one that is about to merge waits for it, and is then tested on top of it.
 *
 * A PR GitHub keeps refusing to merge or update leaves the queue for a person after
 * `MAX_REFUSALS` refusals of the same head; GitHub being down or rate-limited never counts, and
 * neither does a fast merge refused for being behind (that head takes the strict path instead).
 *
 * Here: who is in the queue and in what order, and the step for one PR (merge it, or bring it
 * up to date). `queue-pass.ts` walks the queue on every tick.
 */

/** When the item's checks first all passed (its place in the queue). */
export const MERGE_QUEUED = "merge_queued";

/** Refusals in a row to merge or update one head before the PR leaves the queue. */
export const MAX_REFUSALS = 3;

/** Join the queue once every check passed; the item keeps its place while it waits. */
export function joinQueue(ctx: FactoryContext, item: FactoryItem): FactoryItem {
  if (item.nudges[MERGE_QUEUED]) return item;
  const at = ctx.now().toISOString();
  return ctx.store.updateItem(item.id, (i) => ({
    ...i,
    nudges: { ...i.nudges, [MERGE_QUEUED]: at },
  }));
}

/** Leave the queue (auto-merge turned off: a person merges it). */
export function leaveQueue(ctx: FactoryContext, item: FactoryItem): FactoryItem {
  if (!item.nudges[MERGE_QUEUED]) return item;
  return ctx.store.updateItem(item.id, (i) => {
    const { [MERGE_QUEUED]: _q, ...nudges } = i.nudges;
    return { ...i, nudges };
  });
}

/** Whether the item's PR is being rebased: rebase requests are out, or CI waits on conflicts. */
export function isRebasing(item: FactoryItem): boolean {
  if (rebaseAsks(item) > 0) return true;
  return item.checks.some((c) => c.name === "ci" && c.detail === CONFLICTS_DETAIL);
}

/** Whether the factory asked GitHub to update the PR's current head, and no new head came yet. */
export function isUpdating(item: FactoryItem): boolean {
  const head = trackedHead(item);
  return head !== null && Boolean(item.nudges[`${UPDATE}${head}`]);
}

function compare(a: FactoryItem, b: FactoryItem): number {
  const revert = (i: FactoryItem) => (i.source === "revert" ? 0 : 1);
  return (
    revert(a) - revert(b) ||
    (a.nudges[MERGE_QUEUED] ?? "").localeCompare(b.nudges[MERGE_QUEUED] ?? "") ||
    (a.pr?.number ?? 0) - (b.pr?.number ?? 0)
  );
}

/** The queue, in the order the PRs merge: verifying work the factory merges itself. */
export function mergeQueue(ctx: FactoryContext, project: Project): FactoryItem[] {
  if (!isFactoryMode(project.autonomyMode)) return [];
  return ctx.store
    .items(project.id, ["verifying"])
    .filter((i) => i.pr && i.nudges[MERGE_QUEUED] && mayAutoMerge(i, project.factoryLimits))
    .sort(compare);
}

/**
 * Whether the queue brought the PR up to date and CI on the new head hasn't passed yet: it
 * merges within one CI run.
 */
export function isRetesting(item: FactoryItem): boolean {
  // Waiting for CI on the default branch (`inherited-ci.ts`) isn't a re-test, and holds up nothing.
  if (waitsForMain(item)) return false;
  if (isUpdating(item)) return true;
  if (!item.nudges[QUEUE_UPDATED]) return false;
  return item.checks.some((c) => c.name === "ci" && c.state === "pending");
}

export function note(ctx: FactoryContext, item: FactoryItem, text: string): void {
  ctx.store.updateItem(item.id, (i) => ({ ...i, note: text }));
}

/** The note of a ready PR while GitHub works out whether it still merges cleanly. */
const SETTLING_NOTE = "Every check passed; waiting for GitHub to work out the merge";

/** Notes the queue writes on a PR it brings up to date (they stand until the new head comes). */
export const UPDATE_NOTE = /^(Re-testing against|Updating it with) /;

/** What one step did with a queued PR. */
export interface Step {
  /**
   * - `merged`: it merged;
   * - `updating`: GitHub is bringing it up to date (asked now or earlier), CI then runs again;
   * - `unsettled`: GitHub hasn't worked out yet whether it merges (the default branch just moved);
   * - `nothing`: the queue has nothing to do with it on this pass.
   */
  did: "merged" | "updating" | "unsettled" | "nothing";
  loop: FactoryLoop;
}

/** What one pass over the queue keeps between its PRs. */
export interface Pass {
  /** Merges made so far. */
  merges: number;
  /** Waits for GitHub that are left. */
  waits: number;
  /** CI on the default branch: read once per pass (our own merges only make it pending). */
  mainCi: "unread" | "read" | "unreadable";
}

/**
 * One queued PR whose checks passed: read it fresh, then merge it or bring it up to date. A new
 * head since the checks ran, or conflicts, are the verify step's to look at first. The review is
 * checked again here: only the head an approval covers merges (`approval.ts`).
 */
export async function act(
  ctx: FactoryContext,
  project: Project,
  loop: FactoryLoop,
  item: FactoryItem,
  pass: Pass,
): Promise<Step> {
  const nothing: Step = { did: "nothing", loop };
  if (!item.pr) return nothing;
  let pr: FactoryPr;
  try {
    pr = await ctx.github.prDetails(project.id, item.pr.number);
  } catch (error) {
    note(ctx, item, `Could not read the PR: ${errorMessage(error)}`);
    return nothing;
  }
  if (pr.ref.state === "merged" || pr.ref.state === "closed") {
    prDecidedOutside(ctx, item, pr.ref);
    return nothing;
  }
  const sha = pr.headSha;
  if (!sha || sha !== trackedHead(item)) return nothing;
  if (pr.mergeable === "unknown") {
    note(ctx, item, SETTLING_NOTE);
    return { did: "unsettled", loop };
  }
  if (pr.mergeable !== "mergeable" || !approvalCovers(item, sha)) return nothing;
  return mergeOrUpdate(ctx, project, loop, item, pr, sha, pass);
}

/** What a merge call came to: merged, GitHub still catching up, or a failure the queue counts. */
function afterMerge(
  ctx: FactoryContext,
  loop: FactoryLoop,
  item: FactoryItem,
  sha: string,
  res: FactoryLoop | MergeFailed,
): Step {
  if (!("failed" in res)) return { did: "merged", loop: res };
  if (res.settling) {
    note(ctx, item, SETTLING_NOTE);
    return { did: "unsettled", loop };
  }
  const next = failed(ctx, loop, item, sha, "Merge failed", res.failed, res.refusal);
  return { did: "nothing", loop: next };
}

async function mergeOrUpdate(
  ctx: FactoryContext,
  project: Project,
  loop: FactoryLoop,
  item: FactoryItem,
  pr: FactoryPr,
  sha: string,
  pass: Pass,
): Promise<Step> {
  let main: MainSince;
  try {
    main = await ctx.github.mainSince(project.id, pr.ref.number, sha);
  } catch (error) {
    note(ctx, item, `Could not compare it with ${baseBranchOf(project)}: ${errorMessage(error)}`);
    return { did: "nothing", loop };
  }
  if (main.behind === 0) {
    const path = item.nudges[QUEUE_UPDATED] ? "retested" : "current";
    const merged = await autoMerge(ctx, project, loop, item, pr, item.checks, { path });
    return afterMerge(ctx, loop, item, sha, merged);
  }
  // An update already asked for this head commits it to the strict path.
  let why: string | null = null;
  if (project.factoryLimits.mergePolicy !== "strict" && !item.nudges[`${UPDATE}${sha}`]) {
    const fast = await tryFast(ctx, project, loop, item, pr, sha, main, pass);
    if ("step" in fast) return fast.step;
    loop = fast.loop;
    why = fast.strict;
  }
  return updateWithMain(ctx, project, loop, item, pr.ref.number, sha, main.behind, why);
}

/** GitHub's answer when branch protection wants the PR up to date before it merges. */
const NOT_UP_TO_DATE = /up.to.date|out of date|behind/i;

/**
 * The fast path (`fast-merge.ts`): merge the PR on its own CI unless it has to be re-tested
 * first. `step` when it merged or the merge failed like any other; otherwise why it re-tests.
 * A fast merge GitHub refuses because the PR is behind (branch protection) isn't counted as a
 * refusal: that head takes the strict path.
 */
async function tryFast(
  ctx: FactoryContext,
  project: Project,
  loop: FactoryLoop,
  item: FactoryItem,
  pr: FactoryPr,
  sha: string,
  main: MainSince,
  pass: Pass,
): Promise<{ step: Step } | { strict: string; loop: FactoryLoop }> {
  const branch = baseBranchOf(project);
  if (item.nudges[`${STRICT}${sha}`])
    return { strict: "GitHub refused to merge it on its own CI", loop };
  if (pass.mainCi === "unread") {
    const read = await withMainCi(ctx, project, loop, branch);
    pass.mainCi = read ? "read" : "unreadable";
    if (read) loop = read;
  }
  if (pass.mainCi === "unreadable") {
    note(ctx, item, `Could not read CI on ${branch}; trying again on the next check`);
    return { step: { did: "nothing", loop } };
  }
  const verdict = fastMergeVerdict({ branch, hold: loop.fastMergeHold, pr, main });
  if (!verdict.fast) {
    if (verdict.protection) protectionForcesStrict(ctx, project, branch);
    return { strict: verdict.reason, loop };
  }
  const commits = `${main.behind} commit${main.behind === 1 ? "" : "s"}`;
  // Brought up to date earlier (and main moved again since): it still cost a second CI run.
  const merged = await autoMerge(ctx, project, loop, item, pr, item.checks, {
    path: item.nudges[QUEUE_UPDATED] ? "retested" : "fast",
    note: `Merged on its own CI (${commits} behind ${branch}, no conflicts); watching CI on ${branch}`,
  });
  if (!("failed" in merged)) {
    // GitHub merged a PR that was behind: branch protection doesn't want them up to date.
    ctx.upToDateRequired.delete(project.id);
    return { step: { did: "merged", loop: merged } };
  }
  // Only a refusal over the PR being behind sends it down the strict path. Anything else
  // (GitHub still catching up, GitHub not answering, a refusal that being up to date wouldn't
  // change) is handled like any other merge: tried again, and refusals count against the head.
  const said = merged.failed.replace(/[.\s]+$/, "");
  if (merged.settling || !merged.refusal || !NOT_UP_TO_DATE.test(said))
    return { step: afterMerge(ctx, loop, item, sha, merged) };
  const at = ctx.now().toISOString();
  ctx.store.updateItem(item.id, (i) => ({
    ...i,
    nudges: { ...i.nudges, [`${STRICT}${sha}`]: at },
  }));
  protectionForcesStrict(ctx, project, branch);
  return { strict: `GitHub didn't merge it on its own CI: ${said}`, loop };
}

/** Branch protection wants PRs up to date: they re-test one at a time, and the user hears once. */
function protectionForcesStrict(ctx: FactoryContext, project: Project, branch: string): void {
  ctx.upToDateRequired.add(project.id);
  noteProtectionForcesStrict(ctx, project, branch);
}

/**
 * The strict path: bring the PR up to date on GitHub (update-branch, head pinned, no agent);
 * CI then runs on the new head and it merges once that passes. `why` says why the fast path
 * didn't apply (null under the strict policy).
 */
async function updateWithMain(
  ctx: FactoryContext,
  project: Project,
  loop: FactoryLoop,
  item: FactoryItem,
  prNumber: number,
  sha: string,
  behind: number,
  why: string | null,
): Promise<Step> {
  const branch = baseBranchOf(project);
  const key = `${UPDATE}${sha}`;
  const asked = item.nudges[key];
  // GitHub makes the new head in the background; ask again if none came within the CI grace.
  if (asked && ctx.now().getTime() - Date.parse(asked) < ctx.ciGraceMs)
    return { did: "updating", loop };
  try {
    await ctx.github.updateBranch(project.id, prNumber, sha);
  } catch (error) {
    const doing = `Could not update it with ${branch}`;
    const next = failed(ctx, loop, item, sha, doing, errorMessage(error), githubRefused(error));
    return { did: "nothing", loop: next };
  }
  const at = ctx.now().toISOString();
  const commits = `${behind} commit${behind === 1 ? "" : "s"} behind`;
  ctx.store.updateItem(item.id, (i) => ({
    ...i,
    note: why
      ? `Re-testing against ${branch} (${why}): updating it (${commits}), then CI runs on the new head`
      : `Updating it with ${branch} (${commits}), then CI runs on the new head`,
    nudges: { ...i.nudges, [key]: at, [QUEUE_UPDATED]: at },
  }));
  return { did: "updating", loop };
}

/** How many times in a row GitHub refused to merge or update this head of the item's PR. */
function refusals(item: FactoryItem, sha: string): number {
  let n = 0;
  while (item.nudges[`${REFUSED}${sha}_${n + 1}`]) n++;
  return n;
}

/**
 * The PR couldn't be merged, or updated with the default branch. When GitHub didn't answer
 * properly (a rate limit, a 5xx or network failure, GitHub not connected) it is only noted and
 * tried again on the next tick, however long that takes. A refusal (`githubRefused`) is counted
 * against that head (a new head starts afresh, `trackHead`): the `MAX_REFUSALS`th takes the PR
 * out of the queue, the item is stuck with what GitHub said (an inbox item, or a recorded
 * decision in a dark factory, and a notice to the PM), and the next PR in line goes ahead.
 */
function failed(
  ctx: FactoryContext,
  loop: FactoryLoop,
  head: FactoryItem,
  sha: string,
  doing: string,
  error: string,
  refusal: boolean,
): FactoryLoop {
  const why = error.replace(/[.\s]+$/, "");
  if (!refusal) {
    note(ctx, head, `${doing}: ${why}; trying again on the next check`);
    return loop;
  }
  const n = refusals(head, sha) + 1;
  const at = ctx.now().toISOString();
  const current = ctx.store.updateItem(head.id, (i) => ({
    ...i,
    note: `${doing}: ${why} (try ${n} of ${MAX_REFUSALS})`,
    nudges: { ...i.nudges, [`${REFUSED}${sha}_${n}`]: at },
  }));
  if (n < MAX_REFUSALS) return loop;
  ctx.log?.(`factory: ${head.id}: GitHub refused #${head.pr?.number} ${n} times; out of the queue`);
  return markStuck(
    ctx,
    loop,
    leaveQueue(ctx, current),
    `${doing} ${n} times in a row; GitHub said: ${why}`,
    `Look at pull request #${head.pr?.number ?? "?"} on GitHub (branch protection, required checks or reviews, merge settings), then merge it yourself or retry the item. The pull requests queued behind it merge meanwhile.`,
  );
}
