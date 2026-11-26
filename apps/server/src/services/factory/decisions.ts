import {
  type Classification,
  type FactoryAdmitRequest,
  type FactoryDismissRequest,
  type FactoryItem,
  type FactoryRetryMode,
  type FactorySetTypeRequest,
  type ReviewVerdict,
  type Session,
  stoppedRetry,
} from "@agent-rishi/contracts";
import { badRequest, conflict, notFound } from "../errors";
import { reviewedHead, verdictHead, withVerdictHead } from "./approval";
import { sessionsToArchive } from "./cleanup";
import type { FactoryContext } from "./context";
import { announceType } from "./intake";
import type { KeptLessons } from "./lessons";
import { closeInboxFor } from "./merge";
import { ownedPr } from "./pr-status";
import { lateReviewPrompt } from "./prompts";
import { trackedHead } from "./rebase";
import { ownershipAfterRetry } from "./rebuild";
import { approveRecheck, recheckOf, recheckSentFor, withoutRecheck } from "./recheck";
import { resumeReview } from "./rereview";
import { environmentBlocked, environmentOnly, withoutStrikes } from "./review-environment";

/**
 * Decisions on work items (§10.1): letting an untrusted issue in, correcting a type, retrying
 * or dismissing work that stopped, and the independent reviewer's verdict. Each records data
 * the state machine acts on.
 */

/** Who made a decision: you (the UI) or the PM (at your request). */
export type DecidedBy = "user" | "pm";

function projectItem(ctx: FactoryContext, projectId: string, itemId: string): FactoryItem {
  const item = ctx.store.item(itemId);
  if (!item || item.projectId !== projectId)
    throw notFound(`No factory item ${itemId}`, "item_not_found");
  return item;
}

function chosen(
  ctx: FactoryContext,
  type: Classification["type"],
  by: DecidedBy,
  rationale: string,
): Classification {
  return { type, confidence: "high", rationale, by, at: ctx.now().toISOString() };
}

/**
 * Let an ignored issue from an untrusted author in. It is classified (or takes the type given)
 * and runs through its pipeline like any other, but it is never merged automatically: a person
 * merges it, whatever the auto-merge setting says.
 */
export async function admit(
  ctx: FactoryContext,
  projectId: string,
  req: FactoryAdmitRequest,
  by: DecidedBy,
): Promise<FactoryItem> {
  const item = projectItem(ctx, projectId, req.itemId);
  if (item.stage !== "ignored") {
    throw conflict(`Item ${item.id} is ${item.stage}, not ignored`, "not_ignored");
  }
  const who = by === "user" ? "you" : "the PM";
  const classification = req.type
    ? chosen(ctx, req.type, by, `Type chosen by ${who} when letting it in`)
    : null;
  const admitted = ctx.store.updateItem(item.id, (i) => ({
    ...i,
    stage: classification ? "backlog" : "candidate",
    trust: "admitted",
    admittedBy: by,
    type: classification?.type ?? i.type,
    classification: classification ?? i.classification,
    reason: null,
    note: `Let in by ${who}; a person merges it`,
    finishedAt: null,
  }));
  if (classification) await announceType(ctx, projectId, admitted, classification);
  return admitted;
}

/** Correct the type of an item that hasn't started yet; it moves to that pipeline. */
export async function setType(
  ctx: FactoryContext,
  projectId: string,
  req: FactorySetTypeRequest,
  by: DecidedBy,
): Promise<FactoryItem> {
  const item = projectItem(ctx, projectId, req.itemId);
  if (item.stage !== "candidate" && item.stage !== "backlog") {
    throw conflict(`Item ${item.id} has already started (${item.stage})`, "already_started");
  }
  if (item.trust === "untrusted") {
    throw conflict("Let the issue in first", "untrusted");
  }
  const who = by === "user" ? "you" : "the PM";
  const classification = chosen(ctx, req.type, by, req.reason ?? `Set by ${who}`);
  const updated = ctx.store.updateItem(item.id, (i) => ({
    ...i,
    stage: "backlog",
    type: req.type,
    classification,
    investigation: null,
    specApproval: null,
    note: null,
  }));
  if (item.type !== req.type) await announceType(ctx, projectId, updated, classification);
  return updated;
}

/**
 * Run an item that stopped (not reproduced, declined, failed checks, closed) again. `rereview`
 * (the default while its PR is open): the open PR goes straight back to a fresh review of its
 * current head, with fresh revise rounds; no reproduce or analyze, no second PR. `rebuild` (the
 * default without one): a fresh attempt from the first step with fresh sessions; its open PR is
 * closed with a link once the new one is open. A rebuild's earlier sessions go to
 * `earlierSessionIds`, which the loop archives once none of them is busy, so none is left
 * behind. If they were archived already, nothing is: a session someone restored since stays.
 */
export function retry(
  ctx: FactoryContext,
  projectId: string,
  itemId: string,
  mode?: FactoryRetryMode,
  by: DecidedBy = "user",
): FactoryItem {
  const item = projectItem(ctx, projectId, itemId);
  // The shared rule (`stoppedRetry`), with the PR's state as last synced from GitHub.
  const synced = item.pr ? (ctx.github.prRef(item.projectId, item.pr.number) ?? item.pr) : null;
  const can = stoppedRetry({ ...item, pr: synced });
  if (!can) {
    throw conflict(`Only stopped items can be retried (this one is ${item.stage})`, "not_stopped");
  }
  const pr = can.pr;
  if ((mode ?? can.mode) === "rereview") {
    if (!pr) {
      throw conflict(
        `Item ${item.id} has no open pull request to re-review: retry it as a rebuild`,
        "no_open_pr",
      );
    }
    const who = by === "user" ? "you" : "the PM";
    return resumeReview(ctx, item, pr, {
      note: `Retried by ${who}: #${pr.number} goes back to a fresh review`,
      retry: true,
    });
  }
  const earlier = item.sessionsArchivedAt ? [] : sessionsToArchive(ctx, item).map((s) => s.id);
  const retried = ctx.store.updateItem(item.id, (i) => ({
    ...i,
    stage: i.type ? "backlog" : "candidate",
    // From the first step: a fresh analysis, and a fresh approval of its spec when that is on.
    investigation: null,
    specApproval: null,
    attempts: 0,
    // A retry is a call to spend more: the per-item cap counts afresh (its cost still shows all).
    itemBudgetSince: ctx.now().toISOString(),
    review: null,
    checks: [],
    pr: null,
    builderSessionId: null,
    builderProvider: null,
    reviewerSessionId: null,
    reviewerProvider: null,
    reviewerNote: null,
    // Its PRs stay owned: the open one and any still to be closed are closed, with a link,
    // once the new attempt's PR is open.
    nudges: ownershipAfterRetry(ctx, i),
    reason: null,
    failureKind: null,
    stop: null,
    replacementSessionId: null,
    mergeWait: null,
    note: "Retried",
    sessionsArchivedAt: null,
    earlierSessionIds: [...new Set([...i.earlierSessionIds, ...earlier])],
    finishedAt: null,
  }));
  closeInboxFor(ctx, item.id, "Retried");
  return retried;
}

/**
 * Dismiss a failed item that holds no open pull request: nothing more is done with it. It is
 * `rejected`, with your reason or, by default, that you dismissed it and why it had stopped.
 * One with an open PR waits for that PR to be merged or closed instead.
 */
export function dismiss(
  ctx: FactoryContext,
  projectId: string,
  itemId: string,
  req: FactoryDismissRequest,
  by: DecidedBy,
): FactoryItem {
  const item = projectItem(ctx, projectId, itemId);
  if (item.stage !== "failed") {
    throw conflict(`Only failed items can be dismissed (this one is ${item.stage})`, "not_failed");
  }
  const open = ownedPr(ctx, item);
  if (open) {
    throw conflict(
      `Its pull request #${open.number} is still open: merge or close it, or retry the item`,
      "pr_open",
    );
  }
  const who = by === "user" ? "you" : "the PM";
  const why = item.reason ? ` (it had stopped: ${item.reason})` : "";
  const dismissed = ctx.store.updateItem(item.id, (i) => ({
    ...i,
    stage: "rejected",
    reason: req.reason ? `Dismissed by ${who}: ${req.reason}` : `Dismissed by ${who}${why}`,
    failureKind: null,
    note: null,
    finishedAt: i.finishedAt ?? ctx.now().toISOString(),
  }));
  closeInboxFor(ctx, item.id, "dismissed");
  return dismissed;
}

/** Why `factory_submit_review` refuses an approval with security concerns. */
export const APPROVE_WITH_CONCERNS =
  "Not recorded: an `approve` can't list `security.concerns`, because they block the merge. If this pull request must fix them, submit `request_changes`. If they can wait, move them to `followUps` (tracked as issues once it merges, never a reason to hold it up) and submit `approve` again.";

/**
 * `factory_submit_review`: the independent reviewer's structured verdict. An approval can't
 * list security concerns (they block the merge; what can wait goes in `followUps`). A verdict
 * that comes late is kept too: while a revise round runs, its findings are `forward`ed to the author (the
 * caller sends them); on a failed item it is recorded for whoever picks the work up. A request
 * for changes that only the reviewer's own environment stands behind is never recorded or
 * forwarded (`review-environment.ts`). The caller then keeps its lessons (`keepLessons`) for the
 * `item` returned, whatever happened to the verdict: they are about the repository, not this
 * pull request.
 */
export function submitReview(
  ctx: FactoryContext,
  session: Session,
  verdict: ReviewVerdict,
): ReviewOutcome & { item: FactoryItem } {
  const item = session.projectId
    ? ctx.store.items(session.projectId).find((i) => i.reviewerSessionId === session.id)
    : undefined;
  if (!item) throw badRequest("You are not reviewing a factory pull request", "not_a_reviewer");
  const head = trackedHead(item);
  if (
    session.branch === null &&
    session.baseBranch &&
    /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/i.test(session.baseBranch) &&
    (session.baseBranch !== reviewedHead(item) || (head && head !== session.baseBranch))
  ) {
    throw conflict("The pull request has moved past this review workspace", "stale_review_head");
  }
  // Security concerns block the merge, so an approval listing one contradicts itself (#339).
  // Refused before anything is kept, lessons included: the reviewer submits again.
  if (verdict.verdict === "approve" && verdict.security.concerns.length > 0) {
    throw badRequest(APPROVE_WITH_CONCERNS, "approve_with_concerns");
  }
  return { ...settleVerdict(ctx, item, verdict), item };
}

/** The reviewer's answer, with what became of its lessons (`keepLessons`). */
export function withKeptLessons<T extends { message: string }>(res: T, lessons: KeptLessons): T {
  if (lessons.dropped) return { ...res, message: `${res.message} ${lessons.dropped}.` };
  if (lessons.kept === 0) return res;
  const kept = lessons.kept === 1 ? "1 lesson" : `${lessons.kept} lessons`;
  return { ...res, message: `${res.message} Kept ${kept} for later builders and reviewers.` };
}

export type ReviewOutcome = {
  recorded: boolean;
  message: string;
  forward?: { sessionId: string; text: string };
};

/** What a reviewer's verdict does to its item. */
function settleVerdict(
  ctx: FactoryContext,
  item: FactoryItem,
  verdict: ReviewVerdict,
): ReviewOutcome {
  // Only the reviewer's own environment stands behind it: no cause in the PR (#206).
  if (environmentOnly(verdict) && (item.stage === "verifying" || item.stage === "building")) {
    return environmentBlocked(ctx, item);
  }
  if (item.stage === "building" && item.builderSessionId && verdict.verdict !== "approve") {
    return {
      recorded: true,
      message:
        "Passed to the author, who is already revising the pull request; you will be asked to review it again.",
      forward: { sessionId: item.builderSessionId, text: lateReviewPrompt(item, verdict) },
    };
  }
  if (item.stage === "failed") {
    const at = ctx.now().toISOString();
    ctx.store.updateItem(item.id, (i) => ({
      ...i,
      review: verdict,
      nudges: withVerdictHead(i.nudges, reviewedHead(i), at),
    }));
    return {
      recorded: true,
      message: `Verdict recorded on the failed item (${verdict.verdict}); it stays with the pull request for whoever picks it up.`,
    };
  }
  if (item.stage !== "verifying") {
    return {
      recorded: false,
      message: `Not recorded: the item is ${item.stage}${item.stage === "building" ? " (the author is revising it; you will be asked to review again)" : ""}.`,
    };
  }
  // A re-check of a conflict resolution: an approval keeps the earlier verdict, and answers only
  // for the head it was asked about (the verify step settles it against the PR's head). Any
  // other verdict replaces the earlier one, and nothing is owed any more.
  const recheck = Boolean(item.review && recheckOf(item));
  const at = ctx.now().toISOString();
  ctx.store.updateItem(item.id, (i) => {
    const { rereview_sent: _s, reviewer: _r, ...rest } = withoutStrikes(i.nudges);
    const keep = recheck && verdict.verdict === "approve" && i.review;
    const nudges = keep ? approveRecheck(rest, at) : withoutRecheck(rest);
    // The head it covers: the one the reviewer was asked about, never a newer one that came
    // while it worked (`approval.ts`); a re-check's approval, the head it re-checked. Only that
    // head merges on an approval, and a stopped item whose PR moves past it is reviewed again.
    const covers = keep ? recheckSentFor(i) || verdictHead(i) : reviewedHead(i);
    return { ...i, review: keep ? i.review : verdict, nudges: withVerdictHead(nudges, covers, at) };
  });
  return {
    recorded: true,
    message: recheck ? recheckRecorded(item, verdict) : `Verdict recorded: ${verdict.verdict}.`,
  };
}

/** What the reviewer is told about its re-check verdict. */
function recheckRecorded(item: FactoryItem, verdict: ReviewVerdict): string {
  if (verdict.verdict !== "approve") return `Re-check recorded: ${verdict.verdict}.`;
  const head = recheckSentFor(item);
  if (!head) {
    return "Re-check recorded: approve. It isn't known which head it covers, so you will be asked to re-check the current head before it merges.";
  }
  if (head === trackedHead(item)) return "Re-check recorded: approve. Your earlier verdict stands.";
  return `Re-check recorded: approve of ${head.slice(0, 7)}. The pull request has a newer head than the one you were asked about, so you will be asked to re-check that too before it merges.`;
}
