import { z } from "zod";
import { Id, ProviderId, Timestamp } from "./common";

/**
 * The factory scorecard (§10.1, Visibility): how each builder and reviewer, by provider and
 * model, did on the work that finished in a window, so a user can pick who builds and who
 * reviews (`FactoryTuning.builderProvider`, `reviewerProvider` and their models) on evidence.
 * Computed when read from the items, their sessions and the usage ledger; nothing is stored.
 *
 * What counts: work items other than the factory's own reverts that merged in the window, or
 * failed in it because of their own work (not infrastructure). Each counts for the builder and
 * reviewer of its last attempt (a Retry starts the count afresh).
 */

/** The windows the scorecard is offered over, in days. */
export const SCORECARD_WINDOWS = [7, 30, 90] as const;

/** A scorecard window, in days. */
export const ScorecardDays = z.union([z.literal(7), z.literal(30), z.literal(90)]);
export type ScorecardDays = z.infer<typeof ScorecardDays>;

/** `GET /api/projects/:id/factory/scorecard?days=30`: the window, 30 days by default. */
export const FactoryScorecardQuery = z.object({
  days: z.coerce.number().pipe(ScorecardDays).default(30),
});
export type FactoryScorecardQuery = z.infer<typeof FactoryScorecardQuery>;

/** Who built or reviewed: a provider and its model. */
export const ScorecardAgent = z.object({
  provider: ProviderId,
  /** The model its session ran; null: the provider's default (none was reported). */
  model: z.string().min(1).nullable(),
});
export type ScorecardAgent = z.infer<typeof ScorecardAgent>;

/** One builder, reviewer or builder and reviewer pair, over the window. */
export const FactoryScorecardRow = z.object({
  /** Stable within a response: the builder's and/or reviewer's provider and model. */
  key: z.string().min(1),
  /** The builder; null in the reviewer list. */
  builder: ScorecardAgent.nullable(),
  /**
   * The reviewer; null in the builder list, and in the reviewer and pair lists for work that
   * had no agent review (a docs-only change).
   */
  reviewer: ScorecardAgent.nullable(),
  /** Work that finished in the window: `merged` + `failed`. */
  finished: z.int().nonnegative(),
  /** Merged in the window, including merges reverted since. */
  merged: z.int().nonnegative(),
  /** Failed in the window because of its own work, without a merge. */
  failed: z.int().nonnegative(),
  /** Merged without a single revise round (a failed review or check, or a revert). */
  firstPass: z.int().nonnegative(),
  /** Revise rounds over the finished work (divide by `finished` for the average). */
  reviseRounds: z.int().nonnegative(),
  /** Merges that were reverted because CI on the default branch failed after them. */
  reverted: z.int().nonnegative(),
  /** Median time from intake to merge, in milliseconds; null without a merge. */
  medianMergeMs: z.number().nonnegative().nullable(),
  /** What the finished work cost (every session of each item, all time; see `FactoryItemCost`). */
  costUsd: z.number().nonnegative(),
  /** `costUsd` per merge, failures included; null without a merge. */
  costPerMergeUsd: z.number().nonnegative().nullable(),
  /** Part of `costUsd` estimated from the price table rather than reported. */
  estimatedUsd: z.number().nonnegative(),
  /** Turns with no reported cost and no price to estimate one from. */
  unpricedTurns: z.int().nonnegative(),
  /** A provider of these sessions is a subscription login: an API-equivalent figure (§12.6). */
  apiEquivalent: z.boolean(),
  /** Merges a person spot-checked (`FactoryItem.spotCheck` decided), whenever they checked. */
  spotChecked: z.int().nonnegative().default(0),
  /** Of those, the ones where the person found a problem. */
  spotProblems: z.int().nonnegative().default(0),
});
export type FactoryScorecardRow = z.infer<typeof FactoryScorecardRow>;

/** `GET /api/projects/:id/factory/scorecard`. Each list: most finished work first, then merges. */
export const FactoryScorecard = z.object({
  projectId: Id,
  days: ScorecardDays,
  /** Start of the window (`days` before the response was built). */
  since: Timestamp,
  /** Work that finished in the window, over every row of a list. */
  finished: z.int().nonnegative(),
  /** By builder: provider and model. */
  builders: z.array(FactoryScorecardRow),
  /** By reviewer: provider and model, or no agent review. */
  reviewers: z.array(FactoryScorecardRow),
  /** By builder and reviewer together. */
  pairs: z.array(FactoryScorecardRow),
});
export type FactoryScorecard = z.infer<typeof FactoryScorecard>;
