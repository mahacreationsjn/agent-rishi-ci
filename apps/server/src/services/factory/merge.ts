import {
  FACTORY_FAILURE_INBOX_PREFIX,
  type FactoryItem,
  type FactoryLoop,
  type GitHubPrRef,
  type MergePath,
  type Project,
} from "@agent-rishi/contracts";
import { errorMessage, ServiceError } from "../errors";
import { type FactoryContext, factoryNotice, raiseInbox } from "./context";
import { followUpsAtMerge } from "./follow-ups";
import type { FactoryPr } from "./github-port";
import { spotCheckAtMerge } from "./spot-checks";
import { stuckDecisionId, stuckInboxId } from "./stuck";

/**
 * The Merge step (§10.1): every check passed. With auto-merge on and trusted work, the factory
 * squash-merges and watches the default branch; otherwise the pull request is the user's to
 * merge on GitHub ("ready for you"). Also what happens when a person merges or closes it.
 */

/** Inbox id of "ready for you to merge". */
export const readyInboxId = (itemId: string) => `inbox:factory-ready:${itemId}`;

/** Inbox id of a PR escalated to the user (a protected area). */
export const escalatedInboxId = (itemId: string) => `inbox:factory-escalated:${itemId}`;

/** The inbox items about an item's PR: ready to merge, protected area, stuck (and its dark-factory decision). */
export function prInboxIds(itemId: string): string[] {
  return [
    FACTORY_FAILURE_INBOX_PREFIX + itemId,
    readyInboxId(itemId),
    escalatedInboxId(itemId),
    stuckInboxId(itemId),
    stuckDecisionId(itemId),
  ];
}

/**
 * Resolve the open inbox items about an item's PR once it is decided or replaced. A resolved
 * decision stays on record (the digest still lists it); it just no longer waits on the user.
 */
export function closeInboxFor(ctx: FactoryContext, itemId: string, note: string): void {
  for (const id of prInboxIds(itemId)) {
    const open = ctx.inbox.find(id);
    if (open?.status === "open") ctx.inbox.close(open, "resolved", { note });
  }
}

/** Point the open inbox items about an item's PR at the PR that replaced it. */
export function retargetInboxFor(ctx: FactoryContext, itemId: string, pr: GitHubPrRef): void {
  for (const id of prInboxIds(itemId)) {
    const open = ctx.inbox.find(id);
    if (open?.status !== "open" || open.pr?.number === pr.number) continue;
    ctx.inbox.put({ ...open, pr, updatedAt: ctx.now().toISOString() });
  }
}

/**
 * The item's PR merged or closed: the factory's requests still waiting in its agent's queue (a
 * rebase, a revise round, a push to start CI) no longer apply, so none is delivered after the
 * merge. Messages from a person or the PM stay.
 */
export function withdrawRequests(ctx: FactoryContext, item: FactoryItem): void {
  if (!item.builderSessionId) return;
  const n = ctx.sessions.withdrawQueued(item.builderSessionId);
  if (n > 0) {
    const what = item.pr ? `#${item.pr.number}` : "its PR";
    ctx.log?.(`factory: ${item.id}: withdrew ${n} queued request(s) after ${what} was decided`);
  }
}

/** The PR was merged or closed by someone (a person, on GitHub). */
export function prDecidedOutside(
  ctx: FactoryContext,
  item: FactoryItem,
  ref: NonNullable<FactoryItem["pr"]>,
): void {
  withdrawRequests(ctx, item);
  const at = ctx.now().toISOString();
  const merged = ref.state === "merged";
  // A person merged it: only the merges always spot-checked are set aside (`spot-checks.ts`).
  const project = merged ? ctx.projects.get(item.projectId) : null;
  const loop = project ? ctx.store.loopOrNew(project.id, ctx.now()) : null;
  ctx.store.updateItem(item.id, (i) => ({
    ...i,
    ...(merged ? followUpsAtMerge(i, at) : {}),
    ...(project && loop ? spotCheckAtMerge(project, loop, i, at, false) : {}),
    pr: ref,
    stage: merged ? "merged" : "rejected",
    // A protected area stays the reason it was a person's to merge.
    reason: merged
      ? i.stage === "escalated"
        ? i.reason
        : null
      : "The pull request was closed on GitHub",
    failureKind: null,
    note: merged ? "Merged on GitHub" : null,
    mergedAt: merged ? (i.mergedAt ?? at) : i.mergedAt,
    finishedAt: i.finishedAt ?? at,
  }));
  closeInboxFor(ctx, item.id, merged ? "merged" : "closed");
}

/** Every check passed and the factory doesn't merge this one: it's the user's to merge. */
export async function readyForYou(
  ctx: FactoryContext,
  project: Project,
  item: FactoryItem,
): Promise<void> {
  const why =
    item.trust === "admitted"
      ? "it came from an untrusted author, so a person merges it"
      : "auto-merge is off";
  ctx.store.updateItem(item.id, (i) => ({
    ...i,
    note: `Ready to merge: every check passed (${why})`,
  }));
  if (item.nudges.ready) return;
  const at = ctx.now().toISOString();
  ctx.store.updateItem(item.id, (i) => ({ ...i, nudges: { ...i.nudges, ready: at } }));
  const passed = item.checks
    .filter((c) => c.state === "pass")
    .map((c) => c.name)
    .join(", ");
  raiseInbox(ctx, {
    id: readyInboxId(item.id),
    kind: "pr_review",
    // The factory won't merge this one: a person has to.
    notify: "needs_you",
    priority: "normal",
    projectId: project.id,
    sessionId: item.builderSessionId,
    issue: item.issue,
    pr: item.pr,
    title: `Ready to merge: ${item.title}`,
    body: `Every factory check passed (${passed}); ${why}. Review the evidence on the pull request and merge it on GitHub.`,
  });
  if (item.pr) {
    await ctx.github
      .comment(
        project.id,
        item.pr.number,
        `Every Agent Rishi software factory check passed (${passed}). Ready for a maintainer to review and merge.`,
      )
      .catch((error: unknown) => ctx.log?.(`factory: comment: ${errorMessage(error)}`));
  }
  factoryNotice(ctx, {
    id: `factory.ready:${item.id}`,
    projectId: project.id,
    target: "pm",
    event: "ready",
    title: `Ready for the user to merge #${item.pr?.number ?? "?"}: ${item.title}`,
    text: `Every check passed; ${why}.`,
    itemIds: [item.id],
    wake: false,
  });
}

/** The error codes GitHub's refusals to merge or update a PR map to (`toGithubError`). */
const REFUSAL_CODES = new Set([
  "github_not_allowed", // 405: not mergeable, a required status check is expected
  "github_conflict", // 409: the head moved, a merge conflict
  "github_validation", // 422
  "github_forbidden", // 403 without a rate limit: e.g. "Resource not accessible by integration"
]);

/**
 * Whether GitHub answered and refused the request, as opposed to not answering properly: a
 * rate limit, a 5xx or network failure, or GitHub not being connected. Only refusals count
 * against a PR in the merge queue; the rest is tried again on the next tick.
 */
export function githubRefused(error: unknown): boolean {
  if (baseJustMoved(error)) return false;
  return error instanceof ServiceError && REFUSAL_CODES.has(error.code);
}

/** GitHub's answer to a merge sent while it still works out the PR against a base that moved. */
const BASE_MOVED = /base branch was modified/i;

/**
 * Whether GitHub turned a merge down only because the default branch moved a moment ago (the
 * merge before it in the queue): it hasn't worked out the PR against the new base yet. Never a
 * refusal: the same merge goes through seconds later.
 */
export function baseJustMoved(error: unknown): boolean {
  return BASE_MOVED.test(errorMessage(error));
}

/**
 * `merged_after_<itemId>`: that item's merge was still being watched (CI on the default branch
 * not finished) when this one merged, so this one stacked on an unverified main (`progress.ts`).
 */
export const MERGED_AFTER = "merged_after_";

/**
 * What GitHub said when it didn't merge a queued PR; `refusal` when it refused it, `settling`
 * when it only hasn't caught up with the default branch moving (`baseJustMoved`).
 */
export interface MergeFailed {
  failed: string;
  refusal: boolean;
  settling: boolean;
}

/**
 * Squash-merge a queued PR, recording how it got there (`path`). When GitHub doesn't merge it,
 * nothing changes here: what it said comes back, and the queue counts the refusals (`queue.ts`).
 */
export async function autoMerge(
  ctx: FactoryContext,
  project: Project,
  loop: FactoryLoop,
  current: FactoryItem,
  pr: FactoryPr,
  checks: FactoryItem["checks"],
  how: { path: MergePath; note?: string },
): Promise<FactoryLoop | MergeFailed> {
  const title = `${current.title} (#${pr.ref.number})`;
  const res = await ctx.github
    .merge(project.id, pr.ref.number, { sha: pr.headSha, title })
    .catch((error: unknown) => ({
      merged: false,
      sha: null,
      error: errorMessage(error),
      refusal: githubRefused(error),
      settling: baseJustMoved(error),
    }));
  if (!res.merged) {
    // A 200 with `merged: false` is GitHub's own answer.
    if (!("error" in res))
      return { failed: "GitHub did not merge it", refusal: true, settling: false };
    return { failed: res.error, refusal: res.refusal, settling: res.settling };
  }
  const at = ctx.now().toISOString();
  // Merges whose CI on main is still running: a failure is theirs to answer first.
  const unverified = ctx.store
    .items(project.id, ["watching"])
    .filter((i) => i.id !== current.id)
    .map((i) => [`${MERGED_AFTER}${i.id}`, at]);
  ctx.store.updateItem(current.id, (i) => {
    const kept = followUpsAtMerge(i, at);
    return {
      ...i,
      // A share of automatic merges is set aside for a person's quick look (`spot-checks.ts`).
      ...spotCheckAtMerge(project, loop, i, at, true),
      stage: "watching",
      pr: { ...pr.ref, state: "merged" },
      mergeSha: res.sha,
      mergePath: how.path,
      mergedAt: at,
      note: how.note ?? "Merged; watching CI on the default branch",
      followUps: kept.followUps,
      nudges: { ...kept.nudges, ...Object.fromEntries(unverified) },
    };
  });
  withdrawRequests(ctx, current);
  const ready = ctx.inbox.find(readyInboxId(current.id));
  if (ready?.status === "open") ctx.inbox.close(ready, "resolved", { note: "merged" });
  if (current.issue && current.source !== "revert") {
    const passed = checks
      .filter((c) => c.state === "pass")
      .map((c) => c.name)
      .join(", ");
    await ctx.github
      .comment(
        project.id,
        current.issue.number,
        `Merged automatically by the Agent Rishi factory in #${pr.ref.number} after every merge check passed (${passed}).`,
      )
      .catch((error: unknown) => ctx.log?.(`factory: comment: ${errorMessage(error)}`));
  }
  factoryNotice(ctx, {
    id: `factory.merged:${current.id}`,
    projectId: project.id,
    target: "pm",
    event: "merged",
    title: `Factory merged #${pr.ref.number}: ${current.title}`,
    text: `Merged ${pr.ref.url} (${res.sha ?? "unknown sha"}); watching CI on the default branch.`,
    itemIds: [current.id],
    wake: false,
  });
  return { ...loop, mergesToday: loop.mergesToday + 1, consecutiveFailures: 0 };
}
