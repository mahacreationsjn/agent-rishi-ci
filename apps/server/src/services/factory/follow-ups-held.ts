import {
  type DigestFollowUps,
  type FactoryFollowUp,
  type FactoryItem,
  type FactoryLoop,
  type FollowUpDropReason,
  type GitHubIssueRef,
  HELD_FOLLOW_UP_DAYS,
  HELD_FOLLOW_UPS_MAX,
  type HeldFollowUp,
  type Project,
  sameFollowUpTitle,
} from "@agent-rishi/contracts";
import { badRequest, conflict } from "../errors";
import type { FactoryContext } from "./context";
import { localDay } from "./policy";
import { FOLLOW_UPS_HELD } from "./store";

/**
 * Review follow-ups held for the dark factory's scout (§10.1, #435). Filing every follow-up the
 * moment its PR merges bypassed the scout's "Issues per round", and each one became a build, a
 * review and a PR with follow-ups of its own. So in a dark factory whose scout runs rounds, a
 * merge holds its low and medium follow-ups on the item (`heldAt`) as findings for the scout,
 * which weighs them with its area reviewers' findings and files at most "Issues per round" in
 * total. High-severity and security follow-ups are still filed at once, outside the cap.
 *
 * The list stays short: a follow-up whose title matches an open issue is linked to it, one
 * matching a follow-up already held is dropped as a duplicate, one held longer than
 * `HELD_FOLLOW_UP_DAYS` is dropped, and past `HELD_FOLLOW_UPS_MAX` the oldest low-severity ones
 * go first. The panel lists them with File now and Dismiss; the daily digest counts them.
 */

const DAY_MS = 24 * 3_600_000;

/**
 * Whether merged work's follow-ups wait for the scout: a dark factory whose scout runs scheduled
 * rounds. With them off (`minBacklog` 0), follow-ups are filed at once as before, so none waits
 * for a round that never comes.
 */
export function scoutHoldsFollowUps(
  project: Pick<Project, "autonomyMode">,
  loop: Pick<FactoryLoop, "tuning">,
): boolean {
  return project.autonomyMode === "dark_factory" && loop.tuning.minBacklog > 0;
}

/** High severity, or the security area: filed at once and not counted toward a round's cap. */
export function filedAtOnce(f: Pick<FactoryFollowUp, "severity" | "area">): boolean {
  return f.severity === "high" || f.area?.trim().toLowerCase() === "security";
}

/** Held for the scout: no issue yet and not dropped. */
export function isHeld(f: FactoryFollowUp): boolean {
  return f.heldAt != null && !f.issue && !f.dropped;
}

/** A held follow-up's id in the scout's brief, cited in `factory_file_issue`'s `findingIds`. */
export function heldFollowUpId(itemId: string, index: number): string {
  return `fu-${itemId.slice(0, 8)}-${index + 1}`;
}

const RANK = { high: 0, medium: 1, low: 2 } as const;
/** Medium when the reviewer gave no severity. */
const rank = (f: { severity?: keyof typeof RANK | null }) => RANK[f.severity ?? "medium"];

/** The project's held follow-ups, as the scout and the panel see them: by severity, oldest first. */
export function heldFollowUps(ctx: FactoryContext, projectId: string): HeldFollowUp[] {
  const held = ctx.store
    .itemsWithFollowUpsHeld(projectId)
    .flatMap((item) =>
      item.followUps.flatMap((f, index) => (isHeld(f) ? [toHeld(item, f, index)] : [])),
    );
  return held.sort((a, b) => rank(a) - rank(b) || a.heldAt.localeCompare(b.heldAt));
}

function toHeld(item: FactoryItem, f: FactoryFollowUp, index: number): HeldFollowUp {
  return {
    id: heldFollowUpId(item.id, index),
    title: f.title,
    severity: f.severity ?? null,
    area: f.area ?? null,
    itemId: item.id,
    index,
    itemTitle: item.title,
    pr: item.pr,
    heldAt: f.heldAt as string,
  };
}

/**
 * Change one follow-up of an item. The `follow_ups_held` nudge follows: set while any of the
 * item's follow-ups is held, so the held list is read without scanning every merged item.
 */
export function setFollowUp(
  ctx: FactoryContext,
  itemId: string,
  index: number,
  patch: Partial<FactoryFollowUp>,
): void {
  const at = ctx.now().toISOString();
  ctx.store.updateItem(
    itemId,
    (i) => {
      const followUps = i.followUps.map((x, n) => (n === index ? { ...x, ...patch } : x));
      const { [FOLLOW_UPS_HELD]: since, ...nudges } = i.nudges;
      return {
        ...i,
        followUps,
        nudges: followUps.some(isHeld) ? { ...nudges, [FOLLOW_UPS_HELD]: since ?? at } : nudges,
      };
    },
    { touch: false },
  );
}

/** The open issue with this title, or one filed earlier in the same pass (`filed`), or null. */
export function openIssueFor(
  ctx: FactoryContext,
  projectId: string,
  title: string,
  filed: readonly GitHubIssueRef[] = [],
): GitHubIssueRef | null {
  const earlier = filed.find((i) => sameFollowUpTitle(i.title ?? "", title));
  if (earlier) return earlier;
  const open = ctx.github.openIssues(projectId).find((i) => sameFollowUpTitle(i.title, title));
  return open ? { number: open.number, url: open.url, title: open.title } : null;
}

/** What one pass over merged work has filed and held so far, so it dedupes against itself. */
export interface FollowUpPass {
  filed: GitHubIssueRef[];
  /** Titles held: the list before the pass, plus the ones it held. */
  held: string[];
}

/**
 * Hold one follow-up of merged work for the scout, unless something tracks it already: one whose
 * title matches an open issue (or one filed earlier in the pass) is linked to it, and one whose
 * title matches a follow-up already held is dropped as a duplicate.
 */
export function holdFollowUp(
  ctx: FactoryContext,
  project: Project,
  item: FactoryItem,
  index: number,
  pass: FollowUpPass,
): void {
  const f = item.followUps[index] as FactoryFollowUp;
  const at = ctx.now().toISOString();
  const open = openIssueFor(ctx, project.id, f.title, pass.filed);
  if (open) {
    setFollowUp(ctx, item.id, index, { issue: open, filedAt: at });
  } else if (pass.held.some((t) => sameFollowUpTitle(t, f.title))) {
    setFollowUp(ctx, item.id, index, { dropped: { reason: "duplicate", at } });
  } else {
    pass.held.push(f.title);
    setFollowUp(ctx, item.id, index, { heldAt: at });
  }
}

function drop(ctx: FactoryContext, h: HeldFollowUp, reason: FollowUpDropReason, at: string) {
  setFollowUp(ctx, h.itemId, h.index, { dropped: { reason, at } });
}

/**
 * Keep the held list current and short (each tick of a dark factory): a held follow-up whose
 * title now matches an open issue is linked to it (the scout or a person filed it), one held
 * longer than `HELD_FOLLOW_UP_DAYS` is dropped, and past `HELD_FOLLOW_UPS_MAX` the oldest
 * low-severity ones are dropped first.
 */
export function maintainHeldFollowUps(ctx: FactoryContext, project: Project): void {
  const at = ctx.now().toISOString();
  const expiry = ctx.now().getTime() - HELD_FOLLOW_UP_DAYS * DAY_MS;
  const kept: HeldFollowUp[] = [];
  for (const h of heldFollowUps(ctx, project.id)) {
    const open = openIssueFor(ctx, project.id, h.title);
    if (open) setFollowUp(ctx, h.itemId, h.index, { issue: open, filedAt: at });
    else if (Date.parse(h.heldAt) < expiry) drop(ctx, h, "expired", at);
    else kept.push(h);
  }
  const over = kept.length - HELD_FOLLOW_UPS_MAX;
  if (over <= 0) return;
  const lowFirst = kept.sort((a, b) => rank(b) - rank(a) || a.heldAt.localeCompare(b.heldAt));
  for (const h of lowFirst.slice(0, over)) drop(ctx, h, "capped", at);
}

/**
 * The scout filed `issue` (`factory_file_issue`): the held follow-ups it covers get the issue and
 * leave the held list.
 */
export function linkHeldFollowUps(
  ctx: FactoryContext,
  covered: readonly HeldFollowUp[],
  issue: GitHubIssueRef,
): void {
  const at = ctx.now().toISOString();
  for (const h of covered) setFollowUp(ctx, h.itemId, h.index, { issue, filedAt: at });
}

/** Dismiss on the panel's held list: the follow-up leaves it without an issue (once). */
export function dismissFollowUp(ctx: FactoryContext, item: FactoryItem, index: number) {
  const f = item.followUps[index];
  if (!f)
    throw badRequest(
      `No follow-up ${index}: the item has ${item.followUps.length}`,
      "no_follow_up",
    );
  if (f.issue) {
    throw conflict(`Already filed as #${f.issue.number}`, "follow_up_filed");
  }
  if (!f.dropped) {
    setFollowUp(ctx, item.id, index, {
      dropped: { reason: "dismissed", at: ctx.now().toISOString() },
    });
  }
  return ctx.store.item(item.id) ?? item;
}

/**
 * The digest's count of review follow-ups for `day` (local): held, filed (got an issue) and
 * dropped or dismissed that day, and how many are held now. Reads every item: a follow-up of a
 * merge weeks ago may expire today.
 */
export function digestFollowUps(items: readonly FactoryItem[], day: string): DigestFollowUps {
  const on = (iso: string | undefined) => iso != null && localDay(new Date(iso)) === day;
  const counts = { held: 0, filed: 0, dropped: 0, dismissed: 0, waiting: 0 };
  for (const f of items.flatMap((i) => i.followUps ?? [])) {
    if (on(f.heldAt)) counts.held++;
    if (f.issue && on(f.filedAt)) counts.filed++;
    if (f.dropped && on(f.dropped.at)) {
      if (f.dropped.reason === "dismissed") counts.dismissed++;
      else counts.dropped++;
    }
    if (isHeld(f)) counts.waiting++;
  }
  return counts;
}
