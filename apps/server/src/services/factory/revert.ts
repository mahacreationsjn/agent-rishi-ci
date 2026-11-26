import {
  type FactoryItem,
  type FactoryLoop,
  type Project,
  ReviewVerdict,
} from "@agent-rishi/contracts";
import { errorMessage } from "../errors";
import { withVerdictHead } from "./approval";
import { baseBranchOf, type FactoryContext, factoryNotice } from "./context";
import type { FactoryPr } from "./github-port";
import { failItem } from "./outcomes";
import { revertedPrompt } from "./prompts-revert";
import { isReReviewRecord } from "./rereview";
import { regressionInboxId, regressionPausePrefix } from "./revert-blocked";
import { unverifiedRevert } from "./revert-watch";
import { isBusy } from "./sessions";
import { claimSlot } from "./slots";
import { REVERTED_AT } from "./stats";
import { AFTER_REVERT, FOLLOW_UPS_DUE, FOLLOW_UPS_HELD } from "./store";

/**
 * Automatic reverts (§10.1, Merge). When CI on the default branch fails after a factory merge,
 * the factory opens a revert PR and pauses. The revert has its own merge rules: its own CI run is
 * its test evidence, it needs no screenshots and its size isn't counted (`checks.ts`), and when
 * it is exactly the inverse of the merge (tree comparison) an automated check stands in for the
 * agent review; otherwise (conflicts resolved, more changed) the normal review applies. It merges
 * first, once its CI is green. When it merged and CI on the default branch is green again, the
 * loop resumes and the reverted work goes back to its builder as a revise round. A revert that
 * can't merge is one clear inbox item (`revert-blocked.ts`); one whose agent couldn't start
 * starts again (`revert-start.ts`); and with none on its way any more, a green default branch
 * ends the regression (`resumeWhenGreen`).
 *
 * Nudges: `revert_inexact_<sha>` on a revert item (that head isn't an exact revert); on the
 * reverted item `after_revert_due` (the revert landed: its revise round is due) and
 * `after_revert` (it went back to its builder after a revert, once per item).
 */

const INEXACT = "revert_inexact_";
const AFTER_REVERT_DUE = "after_revert_due";
/** On the reverted item: the checks that failed on its merge commit, `failed_on_main:<names>`. */
const FAILED_ON_MAIN = "failed_on_main:";

/** The item whose merge a revert item reverts. */
function revertedItem(ctx: FactoryContext, revert: FactoryItem): FactoryItem | undefined {
  return revert.revertOf ? ctx.store.item(revert.revertOf) : undefined;
}

/** Reverts still on their way: queued to start, being written, checked or watched on main. */
function liveReverts(ctx: FactoryContext, projectId: string): FactoryItem[] {
  return ctx.store
    .items(projectId, ["backlog", "building", "verifying", "watching"])
    .filter((i) => i.source === "revert");
}

/** A revert that merged (by the factory, or by a person on GitHub), not one that only finished. */
function revertMerged(revert: FactoryItem): boolean {
  return revert.stage === "merged" && (revert.mergeSha !== null || revert.pr?.state === "merged");
}

/** The verdict an exact revert gets instead of an agent review. */
function revertVerdict(branch: string, prNumber: number | null, mergeSha: string): ReviewVerdict {
  const of = prNumber ? `#${prNumber}` : mergeSha.slice(0, 7);
  return ReviewVerdict.parse({
    verdict: "approve",
    summary: `Automated revert check: its tree is ${branch} as it was before ${of} (${mergeSha.slice(0, 7)}), so it is exactly the inverse of a change that was reviewed and tested before`,
    criteria: [{ criterion: `Restores ${branch} to its state before ${of}`, met: true }],
    vision: { aligned: true },
    tests: { adequate: true, notNeeded: true, note: "A revert restores the tests as they were" },
    security: { concerns: [] },
  });
}

/**
 * The review of a revert PR (before the merge checks run on it): when its head is exactly the
 * inverse of the merge, by tree comparison, the automated verdict approves that head and no
 * reviewer starts. Otherwise the head is marked, and the normal review applies. Once a verdict is
 * on record its later heads follow the usual rules (`approval.ts`): a head that only brought the
 * default branch in keeps the approval, any other change is re-checked by a reviewer. Null when
 * GitHub couldn't answer: the item waits for the next pass, so no reviewer starts on a revert that
 * may well be exact.
 */
export async function checkRevert(
  ctx: FactoryContext,
  project: Project,
  item: FactoryItem,
  pr: FactoryPr,
): Promise<FactoryItem | null> {
  const head = pr.headSha;
  if (item.source !== "revert" || !head || item.reviewerSessionId || item.review) return item;
  if (item.nudges[`${INEXACT}${head}`]) return item;
  const original = revertedItem(ctx, item);
  const mergeSha = original?.mergeSha ?? null;
  let exact = false;
  if (mergeSha) {
    try {
      exact = await ctx.github.revertMatches(project.id, { headSha: head, mergeSha });
    } catch (error) {
      const note = `Could not compare the revert with the merge it reverts: ${errorMessage(error)}`;
      ctx.store.updateItem(item.id, (i) => ({ ...i, note }), { touch: false });
      return null;
    }
  }
  const at = ctx.now().toISOString();
  if (!exact || !mergeSha) {
    return ctx.store.updateItem(item.id, (i) => ({
      ...i,
      note: "Not an exact revert of the merge (conflicts were resolved, or it changes more): the normal review applies",
      nudges: { ...i.nudges, [`${INEXACT}${head}`]: at },
    }));
  }
  const verdict = revertVerdict(baseBranchOf(project), original?.pr?.number ?? null, mergeSha);
  return ctx.store.updateItem(item.id, (i) => ({
    ...i,
    review: verdict,
    reviewerNote: "An exact revert: an automated check (tree comparison) stands in for the review",
    note: null,
    nudges: withVerdictHead(i.nudges, head, at),
  }));
}

/** Record on the reverted item which checks failed on its merge commit (for its revise round). */
export async function recordMainFailure(
  ctx: FactoryContext,
  project: Project,
  item: FactoryItem,
): Promise<string[]> {
  if (!item.mergeSha) return [];
  const failed = await ctx.github.failedChecks(project.id, item.mergeSha).catch(() => []);
  if (failed.length === 0) return [];
  const at = ctx.now().toISOString();
  const key = `${FAILED_ON_MAIN}${failed.join(",").slice(0, 300)}`;
  ctx.store.updateItem(
    item.id,
    (i) => {
      const kept = Object.entries(i.nudges).filter(([k]) => !k.startsWith(FAILED_ON_MAIN));
      return { ...i, nudges: { ...Object.fromEntries(kept), [key]: at } };
    },
    { touch: false },
  );
  return failed;
}

function failedOnMain(item: FactoryItem): string[] {
  const key = Object.keys(item.nudges).find((k) => k.startsWith(FAILED_ON_MAIN));
  return key ? key.slice(FAILED_ON_MAIN.length).split(",").filter(Boolean) : [];
}

/**
 * The revert merged and CI on the default branch passed on it: the regression is over. Its inbox
 * item is resolved, the loop resumes when a regression paused it and no other revert is still on
 * its way (a pause for another reason stays), and the reverted item's revise round is due
 * (`reviseAfterReverts`).
 */
export function revertLanded(
  ctx: FactoryContext,
  project: Project,
  loop: FactoryLoop,
  revert: FactoryItem,
): FactoryLoop {
  const branch = baseBranchOf(project);
  const original = revertedItem(ctx, revert);
  const at = ctx.now().toISOString();
  const revertPr = revert.pr ? `#${revert.pr.number}` : "the revert";
  const inbox = ctx.inbox.find(regressionInboxId(original?.id ?? revert.id));
  if (inbox?.status === "open") {
    ctx.inbox.close(inbox, "resolved", {
      note: `reverted in ${revertPr}; CI on ${branch} is green again`,
    });
  }
  if (original?.stage === "reverted") {
    ctx.store.updateItem(original.id, (i) => ({
      ...i,
      note: `Reverted in ${revertPr}; CI on ${branch} is green again, so it goes back to its builder`,
      nudges: { ...i.nudges, [AFTER_REVERT_DUE]: at },
    }));
  }
  // Another revert still on its way means another regression still holds the default branch.
  const pending = liveReverts(ctx, project.id).some((i) => i.id !== revert.id);
  const paused =
    loop.state === "paused" &&
    !pending &&
    Boolean(loop.pausedReason?.startsWith(regressionPausePrefix(branch)));
  factoryNotice(ctx, {
    id: `factory.revert-landed:${revert.id}`,
    projectId: project.id,
    target: "pm",
    event: "regression",
    title: `Revert ${revertPr} merged; CI on ${branch} is green again`,
    text: `${paused ? "The loop resumed. " : ""}${original ? `"${original.title}" goes back to its builder with the CI failure, as a revise round.` : ""}`,
    itemIds: [revert.id, ...(original ? [original.id] : [])],
    wake: false,
  });
  if (!paused) return loop;
  ctx.log?.(`factory: resuming ${project.id}: revert ${revertPr} merged and ${branch} is green`);
  return { ...loop, state: "idle", pausedReason: null };
}

/**
 * The user resumed the loop: they judged the default branch themselves. A merged revert whose CI
 * on it never reported is no longer watched, and work whose revert merged (green, red or never
 * verified) goes back to its builder as a revise round, as when CI turned green: once per item
 * (`reviseAfterReverts`). Its regression's inbox item is resolved.
 */
export function revertsOnResume(ctx: FactoryContext, projectId: string): void {
  const at = ctx.now().toISOString();
  const reverts = ctx.store
    .items(projectId, ["watching", "merged"])
    .filter((i) => i.source === "revert" && (revertMerged(i) || unverifiedRevert(i)));
  for (const revert of reverts) {
    if (revert.stage === "watching") {
      ctx.store.updateItem(revert.id, (i) => ({
        ...i,
        stage: "merged",
        note: "The loop was resumed before CI on the default branch reported on this revert",
        finishedAt: at,
      }));
    }
    const original = revertedItem(ctx, revert);
    if (original?.stage !== "reverted") continue;
    if (original.nudges[AFTER_REVERT] || original.nudges[AFTER_REVERT_DUE]) continue;
    ctx.store.updateItem(original.id, (i) => ({
      ...i,
      note: "The loop was resumed after its revert merged, so it goes back to its builder",
      nudges: { ...i.nudges, [AFTER_REVERT_DUE]: at },
    }));
    const inbox = ctx.inbox.find(regressionInboxId(original.id));
    if (inbox?.status === "open") ctx.inbox.close(inbox, "resolved", { note: "loop resumed" });
  }
}

/**
 * A regression pause with no revert on its way any more (a person closed it and fixed the
 * default branch forward, or merged it on GitHub, so nobody watches CI on it): once CI on the
 * default branch is green again, whatever fixed it, the regression is over and the loop resumes,
 * as when a revert lands (#509). Work whose revert merged goes back to its builder, once
 * (`revertsOnResume`); work whose revert didn't keeps its merge. Another pause stays.
 */
export async function resumeWhenGreen(
  ctx: FactoryContext,
  project: Project,
  loop: FactoryLoop,
): Promise<FactoryLoop> {
  const branch = baseBranchOf(project);
  if (loop.state !== "paused" || !loop.pausedReason?.startsWith(regressionPausePrefix(branch)))
    return loop;
  if (liveReverts(ctx, project.id).length > 0) return loop;
  const head = await ctx.github.mainHead(project.id).catch(() => null);
  if (head?.checks !== "success") return loop;
  revertsOnResume(ctx, project.id);
  const green = `CI on ${branch} is green again (${head.sha.slice(0, 7)})`;
  const reverts = ctx.store.items(project.id).filter((i) => i.source === "revert");
  for (const original of ctx.store.items(project.id, ["reverted"])) {
    const inbox = ctx.inbox.find(regressionInboxId(original.id));
    if (inbox?.status !== "open") continue;
    if (reverts.some((r) => r.revertOf === original.id && revertMerged(r))) {
      ctx.inbox.close(inbox, "resolved", { note: green });
      continue;
    }
    ctx.inbox.close(inbox, "resolved", { note: `${green}; the revert didn't merge` });
    ctx.store.updateItem(original.id, (i) => ({
      ...i,
      note: `Its revert didn't merge, and ${green}: its merge stands`,
    }));
  }
  factoryNotice(ctx, {
    id: `factory.regression-over:${project.id}:${head.sha}`,
    projectId: project.id,
    target: "pm",
    event: "regression",
    title: `${green}; the loop resumed`,
    text: "No revert is on its way any more, so the loop no longer waits for one.",
    wake: false,
  });
  ctx.log?.(`factory: resuming ${project.id}: ${branch} is green with no revert on its way`);
  return { ...loop, state: "idle", pausedReason: null };
}

/**
 * The nudges a reverted item's revise round starts from: its revise rounds, automatic re-reviews,
 * PRs still to close and follow-ups still to file or held for the scout are kept; the merge's own marks (its queue
 * place, the merges it stacked on, its heads and approvals) are dropped, so the new PR starts
 * afresh and its merge isn't judged against the old one's.
 */
function reviseNudges(nudges: FactoryItem["nudges"]): FactoryItem["nudges"] {
  return Object.fromEntries(
    Object.entries(nudges).filter(
      ([k]) =>
        k.startsWith("fix_") ||
        k.startsWith("supersede_") ||
        k.startsWith(FAILED_ON_MAIN) ||
        k === FOLLOW_UPS_DUE ||
        k === FOLLOW_UPS_HELD ||
        k === REVERTED_AT ||
        k === AFTER_REVERT ||
        (isReReviewRecord(k) && !k.startsWith("verdict_")),
    ),
  );
}

/**
 * Reverted work whose revert landed goes back to its builder as a revise round, with the CI
 * failure on the default branch: once per item (reverted again, it stays reverted), and only
 * while its builder session exists (otherwise it fails, and Retry builds it again). Waking the
 * builder takes a free agent, like any revise round (`slots.ts`); until then it waits.
 */
export async function reviseAfterReverts(ctx: FactoryContext, project: Project): Promise<void> {
  for (const item of ctx.store.items(project.id, ["reverted"])) {
    if (item.nudges[AFTER_REVERT_DUE]) await reviseAfterRevert(ctx, project, item);
  }
}

async function reviseAfterRevert(
  ctx: FactoryContext,
  project: Project,
  item: FactoryItem,
): Promise<void> {
  const branch = baseBranchOf(project);
  const without = (n: FactoryItem["nudges"]) => {
    const { [AFTER_REVERT_DUE]: _due, ...rest } = n;
    return rest;
  };
  if (item.nudges[AFTER_REVERT]) {
    ctx.store.updateItem(item.id, (i) => ({
      ...i,
      note: `Reverted again after CI on ${branch} failed; it went back to its builder once already, so it stays reverted`,
      nudges: without(i.nudges),
    }));
    return;
  }
  const builder = item.builderSessionId ? ctx.repo.find(item.builderSessionId)?.session : undefined;
  if (!builder) {
    ctx.store.updateItem(item.id, (i) => ({ ...i, nudges: without(i.nudges) }));
    const loop = ctx.store.loopOrNew(project.id, ctx.now());
    failItem(
      ctx,
      loop,
      item,
      `Reverted after CI on ${branch} failed, and its builder session is gone: Retry builds it again`,
      { countsAsFailure: false },
    );
    return;
  }
  if (
    !isBusy(builder) &&
    !claimSlot(ctx, project, "repair", `repair:${item.id}`, { wake: builder.id })
  ) {
    const note = "Back to its builder after the revert: waiting for a free agent";
    ctx.store.updateItem(item.id, (i) => ({ ...i, note }), { touch: false });
    return;
  }
  const revert = ctx.store.items(project.id, ["merged"]).find((i) => i.revertOf === item.id);
  const failed = failedOnMain(item);
  const at = ctx.now().toISOString();
  const n = item.attempts + 1;
  const prNumber = item.pr?.number ?? 0;
  const revertPr = revert?.pr ? ` #${revert.pr.number}` : "";
  // Told first: a message that fails is sent again on the next tick, with the item unchanged.
  await ctx.sessions.message(
    builder.id,
    revertedPrompt({
      branch,
      prNumber,
      mergeSha: item.mergeSha ?? "",
      failed,
      revertPr: revert?.pr?.number ?? null,
      revertSha: revert?.mergeSha ?? null,
    }),
  );
  ctx.store.updateItem(item.id, (i) => ({
    ...i,
    stage: "building",
    attempts: n,
    review: null,
    checks: [],
    reason: null,
    failureKind: null,
    // A stop recorded before it merged (`stops.ts`) is over: the builder is told to carry on.
    stop: null,
    note: `Revise round ${n} after the revert: CI on ${branch} failed after #${prNumber} merged${failed.length ? ` (${failed.join(", ")})` : ""}; reverted in${revertPr || " a revert"}`,
    // The reverted merge's record (`mergeSha`, `mergedAt`, `mergePath`) stays until it merges
    // again, so the figures and the digest still count that merge and its revert (`stats.ts`).
    finishedAt: null,
    // Archived again by cleanup once it finishes.
    sessionsArchivedAt: null,
    nudges: {
      ...reviseNudges(i.nudges),
      [`fix_${n}`]: at,
      [AFTER_REVERT]: at,
      ...(i.reviewerSessionId ? { rereview_pending: at } : {}),
    },
  }));
}
