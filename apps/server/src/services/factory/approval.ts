import type { FactoryItem, ReviewVerdict } from "@agent-rishi/contracts";
import type { FactoryPr } from "./github-port";
import { trackedHead } from "./rebase";
import { owedRecheck, recheckOf } from "./recheck";

/**
 * An approval covers one head commit (§10.1, Review and Merge). A verdict covers the head the
 * reviewer was asked to review, and the `review` merge check passes only while that head is the
 * PR's head. A new head with the same change as the approved one (`FactoryPr.diffKey`: the merge
 * queue's update-branch, a rebase that brought only the default branch in, an empty commit that
 * re-runs CI) keeps the approval. Any other new head (the builder's commits, anyone's push) owes
 * a re-check of what changed since the approved head (`recheck.ts`), and nothing merges until
 * the reviewer approves it. The merge queue checks the approval again right before it merges.
 *
 * Nudges:
 * - `verdict_<sha>`: the head the item's latest verdict covers;
 * - `asked_<sha>`: the head the reviewer was last asked to review (a verdict covers that one);
 * - `diff_<sha>:<key>`: the `diffKey` of a head the factory saw (the last one).
 */

const VERDICT = "verdict_";
const ASKED = "asked_";
const DIFF = "diff_";

function markOf(nudges: FactoryItem["nudges"], prefix: string): string | null {
  const key = Object.keys(nudges).find((k) => k.startsWith(prefix));
  return key ? key.slice(prefix.length) : null;
}

/** The nudges with `prefix<value>` as the only mark of its kind (unchanged when it already is). */
function withMark(
  nudges: FactoryItem["nudges"],
  prefix: string,
  value: string | null,
  at: string,
): FactoryItem["nudges"] {
  const marks = Object.keys(nudges).filter((k) => k.startsWith(prefix));
  if (value && marks.length === 1 && marks[0] === `${prefix}${value}`) return nudges;
  const rest = Object.fromEntries(Object.entries(nudges).filter(([k]) => !k.startsWith(prefix)));
  return value ? { ...rest, [`${prefix}${value}`]: at } : rest;
}

/** The PR head the item's last recorded verdict covers; null when unknown. */
export function verdictHead(item: Pick<FactoryItem, "nudges">): string | null {
  return markOf(item.nudges, VERDICT);
}

/** The nudges recording that the item's latest verdict covers `head`. */
export function withVerdictHead(
  nudges: FactoryItem["nudges"],
  head: string | null,
  at: string,
): FactoryItem["nudges"] {
  return withMark(nudges, VERDICT, head, at);
}

/** Whether a nudge records the head a verdict covers (kept when the item starts afresh). */
export function isVerdictRecord(key: string): boolean {
  return key.startsWith(VERDICT);
}

/** The head the reviewer was last asked to review; null when not recorded. */
export function askedHead(item: Pick<FactoryItem, "nudges">): string | null {
  return markOf(item.nudges, ASKED);
}

/** The nudges recording that the reviewer is asked to review `head` (the PR's head now). */
export function withAskedHead(
  nudges: FactoryItem["nudges"],
  head: string | null,
  at: string,
): FactoryItem["nudges"] {
  return withMark(nudges, ASKED, head, at);
}

/**
 * The head a verdict submitted now covers: the one the reviewer was asked to review, never a
 * newer one that came while it worked. Items asked before this was recorded: the head last seen.
 */
export function reviewedHead(item: Pick<FactoryItem, "nudges">): string | null {
  return askedHead(item) ?? trackedHead(item);
}

/** The diff fingerprint recorded for the head last seen: `{ head, key }`, or null. */
function seenDiff(nudges: FactoryItem["nudges"]): { head: string; key: string } | null {
  const mark = markOf(nudges, DIFF);
  const at = mark?.lastIndexOf(":") ?? -1;
  return mark && at > 0 ? { head: mark.slice(0, at), key: mark.slice(at + 1) } : null;
}

/**
 * Settle the item's approval against the PR's head on a verification pass. `before` are the
 * nudges as the pass found them (`head_<sha>` is the head seen last), `after` the pass's own
 * (head tracked, conflicts settled):
 * - a new head with the same change as the head seen last takes over its marks: a verdict, and
 *   a review request, about that head are about this one;
 * - the new head's fingerprint is recorded;
 * - an approval of an older head owes a re-check of the new commits, unless one is owed already
 *   (a conflict resolution's, which compares with the approved head too).
 */
export function settleApproval(
  before: FactoryItem["nudges"],
  after: FactoryItem["nudges"],
  pr: Pick<FactoryPr, "headSha" | "diffKey">,
  review: ReviewVerdict | null,
  at: string,
): FactoryItem["nudges"] {
  const head = pr.headSha;
  const seen = trackedHead({ nudges: before });
  const diff = seenDiff(before);
  let next = withMark(after, DIFF, head && pr.diffKey ? `${head}:${pr.diffKey}` : null, at);
  const sameChange =
    head !== null &&
    seen !== null &&
    seen !== head &&
    diff?.head === seen &&
    diff.key === pr.diffKey;
  if (sameChange) {
    if (verdictHead({ nudges: next }) === seen) next = withVerdictHead(next, head, at);
    if (askedHead({ nudges: next }) === seen) next = withAskedHead(next, head, at);
  }
  if (review?.verdict !== "approve" || !head) return next;
  let approved = verdictHead({ nudges: next });
  if (!approved) {
    // An approval recorded before heads were: it covers the head seen before this pass.
    approved = seen ?? head;
    next = withVerdictHead(next, approved, at);
  }
  if (approved === head || recheckOf({ nudges: next }) !== null) return next;
  return { ...next, ...owedRecheck(approved, at, "commits") };
}

/**
 * Whether the item's review lets head `sha` merge, checked again right before the merge call:
 * the review was skipped (a docs-only change), or an approval covers exactly that head and no
 * re-check is owed.
 */
export function approvalCovers(item: FactoryItem, sha: string): boolean {
  if (item.checks.find((c) => c.name === "review")?.state === "skipped") return true;
  return item.review?.verdict === "approve" && verdictHead(item) === sha && !recheckOf(item);
}
