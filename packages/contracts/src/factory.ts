import { z } from "zod";

/**
 * Project autonomy modes, the software factory and the dark factory (§10.1). The factory loop
 * itself lives in `factory-api.ts` and `factory-pipeline.ts`.
 */

/** The mode ids, in ladder order. */
export const AUTONOMY_MODES = ["manual", "assisted", "software_factory", "dark_factory"] as const;

/** The id the software factory had before 0.6 ("autopilot"); still read from old events. */
const LEGACY_SOFTWARE_FACTORY = "autopilot";

/**
 * A ladder climbed one step at a time:
 * - `manual`: you find work and merge; you drive every session.
 * - `assisted` (default): you, the PM and automations find work; you merge.
 * - `software_factory`: issues filed on GitHub (by you or trusted people) are classified as a
 *   bug, a feature or a docs change and run through that pipeline by a pool of agents, ending
 *   in a pull request with test results and screenshots. You merge, unless auto-merge is on.
 * - `dark_factory`: the software factory plus a scheduled scout that reviews the app against
 *   the vision and files the issues itself.
 *
 * `autopilot` (the software factory's id before 0.6) is still accepted and read as
 * `software_factory`, so old events and API clients keep working.
 */
export const AutonomyMode = z.preprocess(
  (v) => (v === LEGACY_SOFTWARE_FACTORY ? "software_factory" : v),
  z.enum(AUTONOMY_MODES),
);
export type AutonomyMode = z.infer<typeof AutonomyMode>;

/** Default location of a project's vision file, relative to the repo root. */
export const DEFAULT_VISION_PATH = ".agent-rishi/VISION.md";

/** A GitHub login as typed by a person: trimmed, without a leading `@`. */
const GithubLogin = z
  .string()
  .trim()
  .transform((s) => s.replace(/^@/, ""))
  .pipe(z.string().regex(/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})(?:\[bot\])?$/, "Not a GitHub login"));

/**
 * How the merge queue (§10.1) handles a queued PR that is behind the default branch:
 * - `fast` (default): merge it on its own green CI whenever GitHub can merge it (GitHub reports
 *   conflicts, and CI on the default branch is watched after every merge). It takes the strict
 *   path only when it and the commits it is missing both changed dependency files (lockfiles,
 *   manifests such as `package.json`, workspace files) or both changed migrations, while CI on
 *   the default branch is red, or when branch protection wants it up to date.
 * - `strict`: always bring it up to date with the default branch (GitHub's update-branch), wait
 *   for CI on the new head, then merge; one PR at a time.
 */
export const MergePolicy = z.enum(["fast", "strict"]);
export type MergePolicy = z.infer<typeof MergePolicy>;

/**
 * How the merge queue merged a PR (`FactoryItem.mergePath`):
 * - `current`: it was already up to date with the default branch when it merged;
 * - `fast`: it was behind and merged on its own CI;
 * - `retested`: the queue brought it up to date, and it merged after CI ran on the new head.
 */
export const MergePath = z.enum(["current", "fast", "retested"]);
export type MergePath = z.infer<typeof MergePath>;

/**
 * Limits and policy of the software and dark factory, enforced by the server (never left to
 * agent judgement).
 */
export const FactoryLimits = z.object({
  /** Agents working at once (the swarm): builders, reviewers, the scout and area reviewers. */
  maxConcurrentSessions: z.int().positive().default(2),
  /** Automatic merges per day (only while `autoMerge` is on). */
  maxMergesPerDay: z.int().nonnegative().default(5),
  /** Daily spend budget; either or both may be set. */
  dailyBudget: z
    .object({
      tokens: z.int().positive().optional(),
      usd: z.number().positive().optional(),
    })
    .prefault({}),
  /**
   * Optional spend cap per work item; either or both may be set, neither (the default) is no
   * cap. It counts every session that worked on the item since it was last retried
   * (`FactoryItem.itemBudgetSince`). An item that reaches it has its running sessions stopped and
   * fails for a person to look at (`stuck`); a retry gives it a fresh allowance. Saved limits
   * from before it existed read as no cap.
   */
  itemBudget: z
    .object({
      tokens: z.int().positive().optional(),
      usd: z.number().positive().optional(),
    })
    .prefault({}),
  /**
   * What counts against the daily budget: `factory` (default) is the factory's own sessions
   * (builders, reviewers, the scout, reverts); `project` is every session in the project.
   */
  budgetScope: z.enum(["factory", "project"]).default("factory"),
  /** Pause the loop after this many failed merge checks or reverts in a row. */
  pauseAfterConsecutiveFailures: z.int().positive().default(3),
  /** Globs that always escalate to a human (auth, payments, migrations, infra, licensing). */
  protectedPaths: z.array(z.string()).default([]),
  /** Deploys/releases are off unless explicitly enabled. */
  allowDeploys: z.boolean().default(false),
  /**
   * Merge pull requests automatically once every merge check passes. Off (the default): the
   * factory stops at "ready to merge" and you merge on GitHub. Work from an untrusted author
   * that was let in by hand is never merged automatically, whatever this says.
   */
  autoMerge: z.boolean().default(false),
  /**
   * With auto-merge on, how a queued PR that is behind the default branch merges (see
   * `MergePolicy`). Saved limits from before it existed read as `fast`.
   */
  mergePolicy: MergePolicy.default("fast"),
  /**
   * GitHub logins whose issues the factory takes on by itself. The account Agent Rishi uses on
   * GitHub is always trusted. Issues from anyone else (on a public repository: anyone at all)
   * are listed as ignored and only taken on when you, or the PM at your request, let one in.
   */
  trustedAuthors: z.array(GithubLogin).max(200).default([]),
});
export type FactoryLimits = z.infer<typeof FactoryLimits>;

/**
 * State of a project's factory loop. `draining`: the kill switch's "Finish current work, then
 * stop" is running (`FactoryLoop.drain`): no new work starts, the work in flight carries on to the
 * end of its pipeline, then the loop stops by itself.
 */
export const FactoryLoopState = z.enum([
  "idle",
  "discovering",
  "building",
  "verifying",
  "paused",
  "stopped",
  "draining",
]);
export type FactoryLoopState = z.infer<typeof FactoryLoopState>;
