import { z } from "zod";
import { GitHubIssueRef, GitHubPrRef, Id, Timestamp } from "./common";

/**
 * Review follow-ups (§10.1, Review and revise): what the reviewer found that doesn't block the
 * pull request and can wait for its own issue. `security.concerns` blocks the merge; a
 * follow-up never does: it fails no merge check and never goes back to the author as a revise
 * round. Once the pull request merges, a dark factory whose scout runs rounds holds the low and
 * medium ones for the scout (`HeldFollowUp`), where they compete with its area reviewers'
 * findings for the round's issues, and files high-severity and security ones at once; with the
 * scout off it files each one at once. The software factory lists them on the item, to file with
 * "File issue".
 */

/** Most follow-ups one verdict may list. */
export const REVIEW_FOLLOW_UPS_MAX = 5;

/** How much a follow-up matters, as the reviewer judged it. */
export const FollowUpSeverity = z.enum(["low", "medium", "high"]);
export type FollowUpSeverity = z.infer<typeof FollowUpSeverity>;

/** One non-blocking finding of a review, as the reviewer submits it. */
export const ReviewFollowUp = z.object({
  /** What to do, specific enough to be an issue title. */
  title: z
    .string()
    .trim()
    .min(1)
    .max(200)
    .describe(
      "What to do later, specific enough to be an issue title, e.g. `Archiving a container session deletes its unpushed commits`",
    ),
  severity: FollowUpSeverity.optional(),
  /** The part of the code it concerns (`runner`, `web`, `auth`). */
  area: z
    .string()
    .trim()
    .min(1)
    .max(60)
    .optional()
    .describe("The part of the code it concerns, e.g. `runner` or `web`"),
});
export type ReviewFollowUp = z.infer<typeof ReviewFollowUp>;

/** The follow-ups of a verdict: a short list, never a reason to hold up the merge. */
export const ReviewFollowUps = z
  .array(ReviewFollowUp)
  .max(REVIEW_FOLLOW_UPS_MAX)
  .describe(
    `Non-blocking: things worth doing that can wait for their own issue (at most ${REVIEW_FOLLOW_UPS_MAX}). They never hold up the merge or go back to the author; once the pull request merges they are tracked as issues, or as findings for the factory's scout.`,
  );

/**
 * Why a follow-up left the scout's held list without an issue: `duplicate` (its title matched
 * one already held), `expired` (held longer than `HELD_FOLLOW_UP_DAYS`), `capped` (over
 * `HELD_FOLLOW_UPS_MAX`, the oldest low-severity ones first) or `dismissed` (a person's Dismiss).
 */
export const FollowUpDropReason = z.enum(["duplicate", "expired", "capped", "dismissed"]);
export type FollowUpDropReason = z.infer<typeof FollowUpDropReason>;

/** A follow-up dropped from the held list: why, and when. */
export const FollowUpDrop = z.object({ reason: FollowUpDropReason, at: Timestamp });
export type FollowUpDrop = z.infer<typeof FollowUpDrop>;

/** A follow-up of a merged item, and the issue that tracks it. */
export const FactoryFollowUp = ReviewFollowUp.extend({
  /**
   * The issue it was filed as, or the open issue with the same title it was matched to; null
   * until it is filed.
   */
  issue: GitHubIssueRef.nullable().default(null),
  /**
   * When the merge held it for the scout instead of filing it (a dark factory whose scout runs
   * rounds, §10.1). It is held while it has no issue and isn't `dropped`. Absent when it never
   * was held.
   */
  heldAt: Timestamp.optional(),
  /** When it got its issue (filed, or linked to the open issue with its title). */
  filedAt: Timestamp.optional(),
  /** Why and when it left the held list without an issue; absent otherwise. */
  dropped: FollowUpDrop.optional(),
});
export type FactoryFollowUp = z.infer<typeof FactoryFollowUp>;

/** Most follow-ups held for the scout; past it, the oldest low-severity ones are dropped first. */
export const HELD_FOLLOW_UPS_MAX = 50;
/** Days a follow-up stays held for the scout before it is dropped. */
export const HELD_FOLLOW_UP_DAYS = 14;

/**
 * A review follow-up held for the dark factory's scout: a scout finding whose source is a review,
 * not an area reviewer. The scout weighs it with its area reviewers' findings and files at most
 * "Issues per round" in total; the factory panel lists it with File now and Dismiss.
 */
export const HeldFollowUp = z.object({
  /** Its id in the scout's briefs (`fu-…`), which `factory_file_issue`'s `findingIds` cite. */
  id: z.string().min(1),
  title: z.string(),
  severity: FollowUpSeverity.nullable(),
  /** The follow-up's own area (`runner`, `web`), as the reviewer named it. */
  area: z.string().nullable(),
  /** The merged item it came from, and its position in that item's `followUps`. */
  itemId: Id,
  index: z.int().nonnegative(),
  itemTitle: z.string(),
  /** The merged pull request whose review found it. */
  pr: GitHubPrRef.nullable(),
  heldAt: Timestamp,
});
export type HeldFollowUp = z.infer<typeof HeldFollowUp>;

/**
 * The body of `POST /api/projects/:id/factory/items/:itemId/follow-ups/file` ("File issue", and
 * "File now" for a held follow-up) and `.../follow-ups/dismiss` (Dismiss a held follow-up).
 */
export const FactoryFileFollowUpRequest = z.object({
  /** Position of the follow-up in the item's `followUps`. */
  index: z.int().nonnegative(),
});
export type FactoryFileFollowUpRequest = z.infer<typeof FactoryFileFollowUpRequest>;

/**
 * Review follow-ups in the daily digest (dark factory): how many the day held for the scout,
 * filed as issues (at once, by the scout or with File now) and dropped from the held list
 * (duplicates, expired, over the cap), how many a person dismissed, and how many are held now.
 */
export const DigestFollowUps = z.object({
  held: z.int().nonnegative().default(0),
  filed: z.int().nonnegative().default(0),
  dropped: z.int().nonnegative().default(0),
  dismissed: z.int().nonnegative().default(0),
  waiting: z.int().nonnegative().default(0),
});
export type DigestFollowUps = z.infer<typeof DigestFollowUps>;

/** Label on the issues filed for review follow-ups (beside the factory's own label). */
export const FOLLOW_UP_LABEL = "agent-rishi-follow-up";

/** Titles that name the same follow-up: case and runs of whitespace don't count. */
export function sameFollowUpTitle(a: string, b: string): boolean {
  const norm = (s: string) => s.trim().replace(/\s+/g, " ").toLowerCase();
  return norm(a) === norm(b);
}
