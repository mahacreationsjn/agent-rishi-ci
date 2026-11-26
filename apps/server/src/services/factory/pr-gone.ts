import type { FactoryItem, GitHubPrRef, Session } from "@agent-rishi/contracts";
import { conflict } from "../errors";
import type { FactoryContext } from "./context";
import { prDecidedOutside, withdrawRequests } from "./merge";
import { AFTER_REVERT } from "./store";

/**
 * Requests about a factory PR go out only while it is open (§10.1, Ownership). A step reads the
 * PR when it starts, but a person or the merge queue can merge or close it before the step asks
 * the PR's agent for something, and a request queued behind a running turn waits until that turn
 * ends. So:
 * - right before a rebase, an integrator or a revise round, the item and its PR (as last synced)
 *   are read again, and nothing is sent for a PR that merged or closed (`prGone`);
 * - when a PR merges or closes, the factory's requests still queued for its agent are withdrawn
 *   (`withdrawRequests`, `merge.ts`);
 * - `create_pull_request` from the agent of an item whose PR merged opens nothing
 *   (`assertNoMergedPr`), unless the work went back to it for a new PR after a revert.
 */

function decided(ref: GitHubPrRef | null | undefined): boolean {
  return ref?.state === "merged" || ref?.state === "closed";
}

/**
 * The item's PR once it merged or closed, from the item or the PR as last synced (every read of
 * the PR from GitHub updates that); null while it is open.
 */
export function decidedPr(ctx: FactoryContext, item: FactoryItem): GitHubPrRef | null {
  const pr = item.pr;
  if (!pr) return null;
  if (decided(pr)) return pr;
  const synced = ctx.github.prRef(item.projectId, pr.number);
  return synced && decided(synced) ? synced : null;
}

/**
 * Right before the factory asks the PR's agent for work on it: true when the PR merged or closed
 * since the step read it. A merge or close the item hadn't recorded yet is recorded now
 * (`prDecidedOutside`, which also withdraws queued requests); the caller sends nothing.
 */
export function prGone(ctx: FactoryContext, item: FactoryItem): boolean {
  const current = ctx.store.item(item.id) ?? item;
  const ref = decidedPr(ctx, current);
  if (!ref) return false;
  if (decided(current.pr)) withdrawRequests(ctx, current);
  else prDecidedOutside(ctx, current, ref);
  ctx.log?.(`factory: ${current.id}: #${ref.number} is ${ref.state}; no request sent`);
  return true;
}

/**
 * Before `create_pull_request` from a factory session: `409 pr_merged` when the session is the
 * agent of an item whose PR already merged. Its branch has no open PR any more, so a push would
 * open a second one for work that is on the default branch already. Work sent back to its builder
 * after a revert is the exception: it is asked for a new PR. While the PR is open, the call
 * updates it as before.
 */
export function assertNoMergedPr(ctx: FactoryContext, session: Session): void {
  if (!session.projectId) return;
  const item = ctx.store.items(session.projectId).find((i) => i.builderSessionId === session.id);
  if (!item) return;
  if (item.stage === "building" && item.nudges[AFTER_REVERT]) return;
  const ref = decidedPr(ctx, item);
  if (ref?.state !== "merged") return;
  throw conflict(
    `Pull request #${ref.number} already merged; nothing to open. The work is on the default branch: don't push or open another pull request. End your turn with \`finish\`.`,
    "pr_merged",
  );
}
