import { z } from "zod";
import { GitHubIssueRef, GitHubPrRef, Id, Timestamp } from "./common";
import type { AutonomyMode } from "./factory";

/**
 * Spot-checks (§10.1, Visibility): a person's quick look at a share of what the factory merged by
 * itself. A dark factory ships code no person has read; sampling some of it keeps that risk
 * measured instead of assumed. When a PR merges, the factory sets a deterministic share of
 * automatic merges aside (`FactoryTuning.spotCheckPercent`), plus every merge of work let in from
 * an untrusted author or allowed past the size limit. A person reads one (the PR view shows its
 * diff) and records **Looks good** or **Found a problem** with a note, which can become a
 * follow-up issue. Nothing waits on it: the factory never blocks on a spot-check. What people find
 * counts in the scorecard, the factory panel and the daily digest.
 */

/** The share of automatic merges a dark factory spot-checks when none is set, in percent. */
export const SPOT_CHECK_DARK_FACTORY_DEFAULT = 10;

/** Longest note a person can record with a spot-check. */
export const SPOT_CHECK_NOTE_MAX = 4_000;

/** The window the share of checks that found a problem is counted over, in days. */
export const SPOT_CHECK_WINDOW_DAYS = 30;

/** Most outstanding spot-checks `FactoryStatus.spotChecks.pending` lists (the newest). */
export const SPOT_CHECK_PENDING_MAX = 20;

/** Most recent checks `FactoryStatus.spotChecks.recent` lists (the newest). */
export const SPOT_CHECK_RECENT_MAX = 10;

/** Longest part of the reviewer's summary a spot-check entry carries. */
export const SPOT_CHECK_VERDICT_SUMMARY_MAX = 300;

/** A share of automatic merges, in percent. */
export const SpotCheckPercent = z.int().min(0).max(100);

/**
 * The share of automatic merges spot-checked in force: the tuning's `spotCheckPercent`, or when
 * it is null the mode's default, `SPOT_CHECK_DARK_FACTORY_DEFAULT` in a dark factory and 0 (off)
 * otherwise. 0 turns spot-checks off entirely, the always-included cases too.
 */
export function spotCheckShare(
  mode: AutonomyMode,
  tuning: { spotCheckPercent?: number | null },
): number {
  if (tuning.spotCheckPercent !== null && tuning.spotCheckPercent !== undefined) {
    return tuning.spotCheckPercent;
  }
  return mode === "dark_factory" ? SPOT_CHECK_DARK_FACTORY_DEFAULT : 0;
}

/**
 * Why a merge was set aside for a spot-check:
 * - `sampled`: it fell in the share of automatic merges;
 * - `untrusted_author`: its issue came from an untrusted author and was let in by hand (always
 *   included, whoever merged it);
 * - `large_change`: it was allowed past the size limit (always included, whoever merged it).
 */
export const SpotCheckReason = z.enum(["sampled", "untrusted_author", "large_change"]);
export type SpotCheckReason = z.infer<typeof SpotCheckReason>;

/**
 * Where a spot-check is: `pending` (waiting for a person's look), `looks_good` or `problem` (a
 * person found something wrong).
 */
export const SpotCheckState = z.enum(["pending", "looks_good", "problem"]);
export type SpotCheckState = z.infer<typeof SpotCheckState>;

/** A work item's spot-check (`FactoryItem.spotCheck`): set when it merged, decided by a person. */
export const SpotCheck = z.object({
  reason: SpotCheckReason,
  state: SpotCheckState,
  /**
   * The merge it is about (the item's `mergedAt` then). A merge reverted before its check isn't
   * outstanding any more; the item's next merge is sampled afresh and replaces the record.
   */
  sampledAt: Timestamp,
  /** When a person recorded what they found; null while pending. */
  checkedAt: Timestamp.nullable().default(null),
  /** What they found (required with `problem`). */
  note: z.string().max(SPOT_CHECK_NOTE_MAX).nullable().default(null),
  /** The follow-up issue filed with the note, once filed. */
  issue: GitHubIssueRef.nullable().default(null),
});
export type SpotCheck = z.infer<typeof SpotCheck>;

/**
 * `POST /api/projects/:id/factory/items/:itemId/spot-check`: what a person found. `problem` needs
 * a note; with `fileIssue` (the default) the note also becomes a follow-up issue.
 */
export const FactorySpotCheckRequest = z.discriminatedUnion("verdict", [
  z.object({
    verdict: z.literal("looks_good"),
    note: z.string().trim().max(SPOT_CHECK_NOTE_MAX).optional(),
  }),
  z.object({
    verdict: z.literal("problem"),
    note: z.string().trim().min(1).max(SPOT_CHECK_NOTE_MAX),
    fileIssue: z.boolean().default(true),
  }),
]);
export type FactorySpotCheckRequest = z.infer<typeof FactorySpotCheckRequest>;
/** What a client sends (`fileIssue` may be left out). */
export type FactorySpotCheckRequestInit = z.input<typeof FactorySpotCheckRequest>;

/** One spot-check as the factory panel's Spot-checks list shows it. */
export const SpotCheckEntry = z.object({
  itemId: Id,
  title: z.string(),
  /** The merged pull request (opened in the PR view). */
  pr: GitHubPrRef.nullable(),
  /** The item's issue. */
  issue: GitHubIssueRef.nullable(),
  check: SpotCheck,
  mergedAt: Timestamp.nullable(),
  /**
   * The independent reviewer's verdict on record, its summary cut to
   * `SPOT_CHECK_VERDICT_SUMMARY_MAX`; null when it had no agent review (a docs-only change).
   */
  verdict: z
    .object({
      verdict: z.enum(["approve", "request_changes", "reject"]),
      summary: z.string(),
    })
    .nullable(),
});
export type SpotCheckEntry = z.infer<typeof SpotCheckEntry>;

/** `FactoryStatus.spotChecks`: the figures and lists of the factory panel's Spot-checks card. */
export const FactorySpotChecks = z.object({
  /** The share of automatic merges spot-checked in force (`spotCheckShare`). */
  percent: SpotCheckPercent.default(0),
  /** Spot-checks waiting for a person's look (merges since reverted excluded). */
  outstanding: z.int().nonnegative().default(0),
  /** Checks a person recorded over the last `SPOT_CHECK_WINDOW_DAYS` days. */
  checked30d: z.int().nonnegative().default(0),
  /** Of those, the ones where they found a problem. */
  problems30d: z.int().nonnegative().default(0),
  /** Outstanding spot-checks, newest merge first (the newest `SPOT_CHECK_PENDING_MAX`). */
  pending: z.array(SpotCheckEntry).default([]),
  /** Checks recorded in the window, newest first (the newest `SPOT_CHECK_RECENT_MAX`). */
  recent: z.array(SpotCheckEntry).default([]),
});
export type FactorySpotChecks = z.infer<typeof FactorySpotChecks>;

/** `FactoryDigest.spotChecks`: spot-checks of the day and of the window. */
export const DigestSpotChecks = z.object({
  /** Checks a person recorded during the day. */
  checkedToday: z.int().nonnegative().default(0),
  /** Of those, the ones where they found a problem. */
  problemsToday: z.int().nonnegative().default(0),
  /** Spot-checks waiting for a person's look when the digest was built. */
  outstanding: z.int().nonnegative().default(0),
  /** Checks recorded over the last `SPOT_CHECK_WINDOW_DAYS` days. */
  checked30d: z.int().nonnegative().default(0),
  /** Of those, the ones where a person found a problem. */
  problems30d: z.int().nonnegative().default(0),
});
export type DigestSpotChecks = z.infer<typeof DigestSpotChecks>;

/** The percentage of checked merges where a person found a problem (rounded); null without checks. */
export function spotCheckProblemPercent(checked: number, problems: number): number | null {
  return checked > 0 ? Math.round((problems / checked) * 100) : null;
}
