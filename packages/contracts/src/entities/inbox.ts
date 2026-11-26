import { z } from "zod";
import { GitHubIssueRef, GitHubPrRef, Id, JsonValue, Timestamp } from "../common";

/** What an inbox item asks of the user (§11.1). */
export const InboxItemKind = z.enum([
  "question",
  "approval",
  "pr_review",
  "run_failed",
  "triage",
  "automation_result",
  "message",
  /** A start request that matched running work (§8.4); resolved with wait/skip/join/force. */
  "conflict",
  /**
   * A session's worktree could not be removed (§9), for example because a program outside
   * Agent Rishi still uses it. Resolved by Agent Rishi once a later attempt removes it.
   */
  "cleanup_failed",
  /**
   * A software factory feature's spec waiting for the user's approval before it is built
   * (§10.1, `FactoryTuning.specApproval`); resolved once they approve it or ask for changes.
   */
  "spec_approval",
  /**
   * Factory merges set aside for a person's quick look (§10.1, `factory-spot-checks.ts`): one item
   * per project ("3 merges to spot-check"), refreshed as merges are sampled and resolved once none
   * is outstanding. Nothing waits on it.
   */
  "spot_check",
  /**
   * `.agent-rishi/project.json` setup commands that changed since a person last saw them (§9 setup
   * scripts): held in new worktrees until the user allows them. One item per project and command
   * list, so a change asks once. Resolved: allowed, they run in new worktrees from then on.
   * Dismissed: still held, and not asked again.
   */
  "setup_change",
]);
export type InboxItemKind = z.infer<typeof InboxItemKind>;

export const InboxItemStatus = z.enum(["open", "resolved", "dismissed"]);
export type InboxItemStatus = z.infer<typeof InboxItemStatus>;

/**
 * Who an inbox item is for, set by the server when it raises the item (§11.1). Settings →
 * Notifications chooses which categories raise a toast and a desktop notification; every item
 * lands in the inbox either way.
 * - `needs_you`: the user should act: approvals and questions, a PR only a person merges, a
 *   factory decision flagged `needsHuman`, a start conflict, a budget alert.
 * - `failure`: something broke and needs a person: a failed run of a session the factory doesn't
 *   look after, a paused factory loop, a regression, a worktree that couldn't be removed.
 * - `factory`: the factory's own activity, which it handles itself: its decisions, PRs it
 *   reviews and merges, its sessions' failures, stopped items, the daily digest.
 * - `automation`: automation results and triage decisions.
 */
export const InboxNotify = z.enum(["needs_you", "failure", "factory", "automation"]);
export type InboxNotify = z.infer<typeof InboxNotify>;

/** One thing waiting on the user. Links to its session, issue and PR and is answerable in place. */
export const InboxItem = z.object({
  id: Id,
  kind: InboxItemKind,
  status: InboxItemStatus,
  priority: z.enum(["low", "normal", "high"]).default("normal"),
  /** Which notification category it raises (items stored before it existed read as `needs_you`). */
  notify: InboxNotify.default("needs_you"),
  title: z.string(),
  body: z.string().nullable(),
  projectId: Id.nullable(),
  sessionId: Id.nullable(),
  threadId: Id.nullable(),
  /** The transcript item (approval_request / user_question) this mirrors. */
  itemId: Id.nullable(),
  /** Provider request id to answer, for approvals and questions. */
  requestId: Id.nullable(),
  issue: GitHubIssueRef.nullable(),
  pr: GitHubPrRef.nullable(),
  automationRunId: Id.nullable(),
  /**
   * How many times it happened; absent means once (`inboxAttempts`). A session has one
   * `run_failed` item: a later failure of the same session (a failed Retry, another crash)
   * updates it in place, counting here, with the latest error as its `body`.
   */
  attempts: z.int().positive().optional(),
  createdAt: Timestamp,
  updatedAt: Timestamp,
  resolvedAt: Timestamp.nullable(),
  /**
   * How it was resolved (decision, answers, note). Items Agent Rishi settles by itself carry
   * `{ by: "agent-rishi" | "factory", note }` (`InboxSettlement`).
   */
  resolution: JsonValue.nullable(),
});
export type InboxItem = z.infer<typeof InboxItem>;

/** How many times an item happened (`InboxItem.attempts`, absent: once). */
export function inboxAttempts(item: Pick<InboxItem, "attempts">): number {
  return item.attempts ?? 1;
}

/**
 * Kinds that ask the user for an answer or a decision before work goes on: approvals, questions
 * (an MCP server's form is a question too), factory specs, changed setup commands, start
 * conflicts and triage decisions.
 */
export const INBOX_ANSWER_KINDS: readonly InboxItemKind[] = [
  "question",
  "approval",
  "spec_approval",
  "setup_change",
  "conflict",
  "triage",
];
const ANSWER_KINDS: ReadonlySet<InboxItemKind> = new Set(INBOX_ANSWER_KINDS);

/** The `notify` of a high-priority item a person has to act on (see `inboxWaitsOnYou`). */
export const INBOX_ACT_NOTIFY: readonly InboxNotify[] = ["needs_you", "failure"];

/**
 * The item waits on the user, so the inbox's bulk dismiss (`POST /api/inbox/dismiss`) never
 * touches it; it can still be dismissed one at a time. True for the kinds that need an answer,
 * and for high-priority items a person has to act on (`notify` `needs_you` or `failure`): a
 * regression or a revert that can't merge, a paused factory loop, stuck work, a factory decision
 * flagged `needsHuman`, an escalated pull request, a budget or usage limit passed. Everything
 * else (ready-for-review notices, failed runs, factory decisions, digests, results) is a notice.
 */
export function inboxWaitsOnYou(item: Pick<InboxItem, "kind" | "priority" | "notify">): boolean {
  if (ANSWER_KINDS.has(item.kind)) return true;
  return item.priority === "high" && INBOX_ACT_NOTIFY.includes(item.notify);
}

/**
 * The resolution of an item Agent Rishi closed by itself, never a person: a `run_failed` item the
 * factory handles (`factory`: it restarts the work, on another provider when this one can't
 * run), or one whose work moved on (`agent-rishi`: the session ran again, another session of the same
 * work succeeded, its pull request merged or closed, its factory item finished). `note` says
 * which, in a few words.
 */
export const InboxSettlement = z.object({
  by: z.enum(["agent-rishi", "factory"]),
  note: z.string(),
});
export type InboxSettlement = z.infer<typeof InboxSettlement>;

/**
 * The resolution of an item a project manager dismissed with `resolve_inbox_item` (§11.1): a
 * stale triage decision or an informational message of its own project. `reason` says why, and
 * `sessionId` is the PM session that did it. The user can restore it from the inbox.
 */
export const InboxPmResolution = z.object({
  by: z.literal("pm"),
  reason: z.string().min(1).max(500),
  sessionId: z.string().nullable(),
});
export type InboxPmResolution = z.infer<typeof InboxPmResolution>;

/** The item was dismissed by a project manager (`InboxPmResolution`), so the user may restore it. */
export function inboxResolvedByPm(item: Pick<InboxItem, "status" | "resolution">): boolean {
  return item.status === "dismissed" && InboxPmResolution.safeParse(item.resolution).success;
}

/**
 * Why a project manager may not dismiss `item` from project `projectId`'s inbox, or null when it
 * may (§11.1). Only open items of its own project, and only triage decisions and informational
 * messages: approvals, questions, MCP forms, conflicts, specs and everything else that a person
 * answers stay with the user, as do messages that wait on them (`inboxWaitsOnYou`).
 */
export function pmResolveRefusal(
  item: Pick<InboxItem, "kind" | "status" | "projectId" | "priority" | "notify">,
  projectId: string,
): string | null {
  if (item.projectId !== projectId) return "That item belongs to another project.";
  if (item.status !== "open") return `That item was already ${item.status}.`;
  if (item.kind === "triage") return null;
  if (item.kind === "message") {
    return inboxWaitsOnYou(item) ? "That message waits on the user; leave it to them." : null;
  }
  if (item.kind === "approval") return "Approvals stay with the user.";
  if (item.kind === "question") {
    return "Questions are answered, not dismissed: use answer_question for your own sessions' questions; the rest stay with the user.";
  }
  return `Only triage decisions and informational messages can be resolved here (this item is a ${item.kind}).`;
}
