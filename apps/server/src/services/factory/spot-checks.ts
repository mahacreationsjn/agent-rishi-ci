import {
  type DigestSpotChecks,
  type FactoryItem,
  type FactoryLoop,
  type FactorySpotCheckRequest,
  type FactorySpotCheckResponse,
  type FactorySpotChecks,
  FOLLOW_UP_LABEL,
  type GitHubIssueRef,
  type Project,
  SPOT_CHECK_PENDING_MAX,
  SPOT_CHECK_RECENT_MAX,
  SPOT_CHECK_VERDICT_SUMMARY_MAX,
  SPOT_CHECK_WINDOW_DAYS,
  type SpotCheck,
  type SpotCheckEntry,
  type SpotCheckReason,
  spotCheckShare,
} from "@agent-rishi/contracts";
import { conflict, errorMessage, notFound } from "../errors";
import { type FactoryContext, raiseInbox } from "./context";
import { FACTORY_LABEL } from "./intake";
import { localDay } from "./policy";
import { revertedAt } from "./stats";

/**
 * Spot-checks (§10.1, Visibility): a person's quick look at a share of what the factory merged by
 * itself. When a PR merges, a deterministic share of automatic merges is set aside
 * (`FactoryTuning.spotCheckPercent`, `spotCheckShare`), plus every merge of work let in from an
 * untrusted author or allowed past the size limit. One inbox item per project says how many wait;
 * a person records Looks good or Found a problem on the factory panel's Spot-checks list, and a
 * problem can become a follow-up issue. Nothing ever waits on a spot-check: it changes no stage,
 * counter, limit or drain.
 */

const DAY_MS = 24 * 60 * 60 * 1000;

/** Most outstanding merges the inbox item's body lists. */
const INBOX_LISTED = 10;

/** The project's one spot-check inbox item. */
export const spotCheckInboxId = (projectId: string) => `inbox:factory-spot-checks:${projectId}`;

/**
 * Where an item falls in the sample, 0..99: FNV-1a (32 bit) of its id, mod 100. The same item
 * always lands in the same place, whenever and in whatever order it merges, and ids spread evenly,
 * so a share of N picks about N in 100 merges.
 */
export function spotCheckBucket(itemId: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < itemId.length; i++) {
    hash ^= itemId.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash % 100;
}

/**
 * Why a merge is set aside for a spot-check, or null when it isn't. `share` is the share in force
 * (`spotCheckShare`); 0 turns it all off. Work let in from an untrusted author and changes allowed
 * past the size limit are always set aside, whoever merged them (`automatic` false: a person on
 * GitHub); otherwise only automatic merges whose bucket falls under the share. The factory's own
 * reverts never are.
 */
export function spotCheckReason(
  item: Pick<FactoryItem, "id" | "source" | "trust" | "largeChange">,
  share: number,
  automatic: boolean,
): SpotCheckReason | null {
  if (share <= 0 || item.source === "revert") return null;
  if (item.trust === "admitted") return "untrusted_author";
  if (item.largeChange !== null) return "large_change";
  if (automatic && spotCheckBucket(item.id) < share) return "sampled";
  return null;
}

/**
 * What a merge at `at` records on the item: a pending spot-check when it is set aside (replacing
 * the record of an earlier merge since reverted), else the record it had.
 */
export function spotCheckAtMerge(
  project: Pick<Project, "autonomyMode">,
  loop: Pick<FactoryLoop, "tuning">,
  item: FactoryItem,
  at: string,
  automatic: boolean,
): Pick<FactoryItem, "spotCheck"> {
  const share = spotCheckShare(project.autonomyMode, loop.tuning);
  const reason = spotCheckReason(item, share, automatic);
  if (!reason) return { spotCheck: item.spotCheck };
  return {
    spotCheck: {
      reason,
      state: "pending",
      sampledAt: at,
      checkedAt: null,
      note: null,
      issue: null,
    },
  };
}

/** Whether the item's spot-check waits for a person: pending, and its merge not reverted since. */
export function spotCheckOutstanding(
  item: Pick<FactoryItem, "spotCheck" | "stage" | "finishedAt" | "mergedAt" | "nudges">,
): boolean {
  const check = item.spotCheck;
  if (check?.state !== "pending") return false;
  const reverted = revertedAt(item);
  return reverted === null || reverted < check.sampledAt;
}

/** The checks people recorded since `since`, newest first. */
function checkedSince(items: FactoryItem[], since: string): FactoryItem[] {
  return items
    .filter((i) => i.spotCheck && i.spotCheck.state !== "pending")
    .filter((i) => (i.spotCheck?.checkedAt ?? "") >= since)
    .sort((a, b) => (b.spotCheck?.checkedAt ?? "").localeCompare(a.spotCheck?.checkedAt ?? ""));
}

/** Outstanding spot-checks of the project, newest merge first. */
function outstandingItems(ctx: FactoryContext, projectId: string): FactoryItem[] {
  return ctx.store
    .spotCheckItems(projectId, null)
    .filter(spotCheckOutstanding)
    .sort((a, b) => (b.spotCheck?.sampledAt ?? "").localeCompare(a.spotCheck?.sampledAt ?? ""));
}

function windowStart(ctx: FactoryContext): string {
  return new Date(ctx.now().getTime() - SPOT_CHECK_WINDOW_DAYS * DAY_MS).toISOString();
}

function cut(text: string, max: number): string {
  const line = text.replace(/\s+/g, " ").trim();
  return line.length <= max ? line : `${line.slice(0, max - 1).trimEnd()}…`;
}

/** One spot-check as the panel's list shows it. */
export function spotCheckEntry(item: FactoryItem): SpotCheckEntry {
  return {
    itemId: item.id,
    title: item.title,
    pr: item.pr,
    issue: item.issue,
    check: item.spotCheck as SpotCheck,
    mergedAt: item.mergedAt,
    verdict: item.review
      ? {
          verdict: item.review.verdict,
          summary: cut(item.review.summary, SPOT_CHECK_VERDICT_SUMMARY_MAX),
        }
      : null,
  };
}

/** `FactoryStatus.spotChecks`: the share in force, the figures and both lists. */
export function spotCheckStatus(
  ctx: FactoryContext,
  project: Project,
  loop: FactoryLoop,
): FactorySpotChecks {
  const since = windowStart(ctx);
  const items = ctx.store.spotCheckItems(project.id, since);
  const pending = items
    .filter(spotCheckOutstanding)
    .sort((a, b) => (b.spotCheck?.sampledAt ?? "").localeCompare(a.spotCheck?.sampledAt ?? ""));
  const checked = checkedSince(items, since);
  return {
    percent: spotCheckShare(project.autonomyMode, loop.tuning),
    outstanding: pending.length,
    checked30d: checked.length,
    problems30d: checked.filter((i) => i.spotCheck?.state === "problem").length,
    pending: pending.slice(0, SPOT_CHECK_PENDING_MAX).map(spotCheckEntry),
    recent: checked.slice(0, SPOT_CHECK_RECENT_MAX).map(spotCheckEntry),
  };
}

/** `FactoryDigest.spotChecks`: the checks of `day` (local), the window's, and what waits. */
export function digestSpotChecks(
  ctx: FactoryContext,
  projectId: string,
  day: string,
): DigestSpotChecks {
  const since = windowStart(ctx);
  const dayStart = new Date(`${day}T00:00:00`).toISOString();
  // Read from whichever starts first: the window, or the day (a digest for a day long past).
  const [from = since] = [since, dayStart].sort();
  const items = ctx.store.spotCheckItems(projectId, from);
  const inWindow = checkedSince(items, since);
  const today = checkedSince(items, dayStart).filter(
    (i) => localDay(new Date(i.spotCheck?.checkedAt ?? 0)) === day,
  );
  return {
    checkedToday: today.length,
    problemsToday: today.filter((i) => i.spotCheck?.state === "problem").length,
    outstanding: items.filter(spotCheckOutstanding).length,
    checked30d: inWindow.length,
    problems30d: inWindow.filter((i) => i.spotCheck?.state === "problem").length,
  };
}

/**
 * Keep the project's one spot-check inbox item in step: "N merges to spot-check", listing the
 * newest, refreshed in place as merges are set aside or checked, and resolved once none waits.
 * A person who dismissed it isn't asked again until another merge is set aside. Each tick, and
 * after each decision.
 */
export function settleSpotCheckInbox(ctx: FactoryContext, project: Project): void {
  const id = spotCheckInboxId(project.id);
  const pending = outstandingItems(ctx, project.id);
  const existing = ctx.inbox.find(id);
  if (pending.length === 0) {
    if (existing?.status === "open") {
      ctx.inbox.close(existing, "resolved", { note: "Nothing left to spot-check" });
    }
    return;
  }
  if (existing?.status === "dismissed") {
    const dismissedAt = existing.resolvedAt ?? existing.updatedAt;
    if (!pending.some((i) => (i.spotCheck?.sampledAt ?? "") > dismissedAt)) return;
  }
  const n = pending.length;
  const listed = pending.slice(0, INBOX_LISTED).map((i) => {
    const pr = i.pr ? ` (#${i.pr.number})` : "";
    return `- ${i.title}${pr}`;
  });
  if (n > INBOX_LISTED) listed.push(`- and ${n - INBOX_LISTED} more`);
  raiseInbox(ctx, {
    id,
    kind: "spot_check",
    notify: "needs_you",
    priority: "low",
    projectId: project.id,
    title: `${n} merge${n === 1 ? "" : "s"} to spot-check (${project.name})`,
    body: [
      `The factory set ${n === 1 ? "this merge" : "these merges"} aside for a quick look. Nothing waits on ${n === 1 ? "it" : "them"}: open the Spot-checks list in the factory panel, read the change in the PR view, and record Looks good or Found a problem.`,
      "",
      ...listed,
    ].join("\n"),
  });
}

/** The follow-up issue's text: the note, the PR it concerns and the reviewer's verdict. */
function issueBody(item: FactoryItem, check: SpotCheck): string {
  const pr = item.pr ? `#${item.pr.number} (${item.pr.url})` : "its pull request";
  const verdict = item.review
    ? [
        "",
        `The independent reviewer's verdict: ${item.review.verdict}: ${cut(item.review.summary, SPOT_CHECK_VERDICT_SUMMARY_MAX)}`,
      ]
    : [];
  return [
    check.note ?? "",
    "",
    `A person spot-checked ${pr}, "${item.title}", after the Agent Rishi factory merged it, and found this problem.`,
    ...verdict,
    "",
    "_Filed by the Agent Rishi factory from a person's spot-check._",
    `<!-- agent-rishi:factory spot-check item=${item.id} -->`,
  ].join("\n");
}

/** File the follow-up issue of a problem a person found, and record it on the item. */
async function fileIssue(
  ctx: FactoryContext,
  project: Project,
  item: FactoryItem,
): Promise<FactoryItem> {
  const check = item.spotCheck as SpotCheck;
  const title = cut(`Spot-check: ${item.title}`, 200);
  const created = await ctx.github.createIssue(project.id, {
    title,
    body: issueBody(item, check),
    labels: [FACTORY_LABEL, FOLLOW_UP_LABEL],
  });
  const issue: GitHubIssueRef = { ...created, title: created.title ?? title };
  return ctx.store.updateItem(
    item.id,
    (i) => ({ ...i, spotCheck: i.spotCheck ? { ...i.spotCheck, issue } : i.spotCheck }),
    { touch: false },
  );
}

/** File the issue, or say why GitHub didn't take it (the verdict is already recorded). */
async function tryFileIssue(
  ctx: FactoryContext,
  project: Project,
  item: FactoryItem,
): Promise<FactorySpotCheckResponse> {
  try {
    return { item: await fileIssue(ctx, project, item), issueError: null };
  } catch (error) {
    ctx.log?.(`factory: filing a spot-check issue of ${item.id}: ${errorMessage(error)}`);
    return { item: ctx.store.item(item.id) ?? item, issueError: errorMessage(error) };
  }
}

function itemOf(ctx: FactoryContext, projectId: string, itemId: string): FactoryItem {
  const item = ctx.store.item(itemId);
  if (!item || item.projectId !== projectId) {
    throw notFound(`No factory item ${itemId}`, "item_not_found");
  }
  return item;
}

/**
 * A person's spot-check of a merge: Looks good, or Found a problem with a note, filed as a
 * follow-up issue with `fileIssue`. The verdict is recorded first, so a GitHub failure never loses
 * it (`issueError` says why; "File issue" tries again). Accepted whatever the loop is doing.
 */
export async function decideSpotCheck(
  ctx: FactoryContext,
  project: Project,
  itemId: string,
  req: FactorySpotCheckRequest,
): Promise<FactorySpotCheckResponse> {
  const item = itemOf(ctx, project.id, itemId);
  if (!spotCheckOutstanding(item)) {
    throw conflict(
      item.spotCheck?.state === "pending"
        ? "This merge was reverted, so there is nothing to spot-check"
        : item.spotCheck
          ? "This merge's spot-check is already recorded"
          : "This merge wasn't set aside for a spot-check",
      "spot_check_not_pending",
    );
  }
  const at = ctx.now().toISOString();
  const note = req.note ? req.note : null;
  const recorded = ctx.store.updateItem(
    item.id,
    (i) => ({
      ...i,
      spotCheck: i.spotCheck ? { ...i.spotCheck, state: req.verdict, checkedAt: at, note } : null,
    }),
    { touch: false },
  );
  const result =
    req.verdict === "problem" && req.fileIssue
      ? await tryFileIssue(ctx, project, recorded)
      : { item: recorded, issueError: null };
  settleSpotCheckInbox(ctx, project);
  return result;
}

/** "File issue": file the follow-up issue of a problem recorded without one. */
export async function fileSpotCheckIssue(
  ctx: FactoryContext,
  project: Project,
  itemId: string,
): Promise<FactorySpotCheckResponse> {
  const item = itemOf(ctx, project.id, itemId);
  if (item.spotCheck?.state !== "problem") {
    throw conflict(
      "Only a spot-check that found a problem files an issue",
      "spot_check_not_problem",
    );
  }
  if (item.spotCheck.issue) {
    throw conflict(
      `The issue is filed already (#${item.spotCheck.issue.number})`,
      "spot_check_issue_filed",
    );
  }
  return tryFileIssue(ctx, project, item);
}
