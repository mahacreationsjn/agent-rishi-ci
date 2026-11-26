import { z } from "zod";
import { Id, Timestamp } from "./common";
import { HeldFollowUp } from "./factory-follow-ups";

/**
 * The software factory's pipelines (§10.1): every piece of work is classified as a bug, a
 * feature or a docs change and runs through that type's steps:
 *
 * ```
 * Issue -> Identify type -+-> Bug:      Reproduce -> Create fix -> Review fix  -+-> Merge
 *                         +-> Feature:  Analyze   -> Implement  -> Review      -+
 *                         +-> Docs:     Implement docs change -----------------+
 * ```
 *
 * A failed review sends the work back to the builder (the revise loop). Merging is yours unless
 * auto-merge is on. Also the dark factory's scout: its review rounds, area reviewers and findings.
 */

/** The three pipelines. */
export const WorkType = z.enum(["bug", "feature", "docs"]);
export type WorkType = z.infer<typeof WorkType>;

/** Who decided the type: a GitHub label, the utility model, keywords, the scout or a person. */
export const ClassifiedBy = z.enum([
  "label",
  "model",
  "heuristic",
  "scout",
  "system",
  "user",
  "pm",
]);
export type ClassifiedBy = z.infer<typeof ClassifiedBy>;

export const Confidence = z.enum(["high", "medium", "low"]);
export type Confidence = z.infer<typeof Confidence>;

/** The "Identify type" step's result. */
export const Classification = z.object({
  type: WorkType,
  confidence: Confidence,
  rationale: z.string().max(1_000),
  by: ClassifiedBy,
  at: Timestamp,
});
export type Classification = z.infer<typeof Classification>;

/**
 * Whether the factory may take work on by itself:
 * - `trusted`: an issue by a trusted author (or the account Agent Rishi uses), or work the factory
 *   found itself (the scout, a failed check on the default branch, a revert);
 * - `untrusted`: an issue by anyone else; it is listed as ignored and nothing runs on it;
 * - `admitted`: an untrusted issue let in by you or by the PM at your request. It runs through
 *   the pipeline but is never merged automatically.
 */
export const WorkTrust = z.enum(["trusted", "untrusted", "admitted"]);
export type WorkTrust = z.infer<typeof WorkTrust>;

/** Outcomes of the first step of the bug (reproduce) and feature (analyze) pipelines. */
export const InvestigationOutcome = z.enum([
  "reproduced",
  "not_reproduced",
  "implement",
  "already_done",
  "needs_info",
  "out_of_scope",
]);
export type InvestigationOutcome = z.infer<typeof InvestigationOutcome>;

/** What the builder found before writing the fix or the feature. */
export const Investigation = z.object({
  kind: z.enum(["reproduction", "analysis"]),
  outcome: InvestigationOutcome,
  summary: z.string().max(2_000),
  /** Reproduction steps, or the spec the feature is built to. */
  details: z.string().max(12_000).nullable(),
  /** The failing test or probe that shows the bug. */
  testPath: z.string().max(500).nullable(),
  at: Timestamp,
});
export type Investigation = z.infer<typeof Investigation>;

/** `factory_report_reproduction`: the bug pipeline's Reproduce step. */
export const FactoryReproductionReport = z.object({
  reproduced: z.boolean(),
  summary: z.string().trim().min(1).max(2_000).describe("What you found, in a few sentences"),
  steps: z
    .string()
    .max(4_000)
    .optional()
    .describe("How to reproduce it: commands or steps, in order"),
  evidence: z
    .string()
    .max(8_000)
    .optional()
    .describe("The failing output, trimmed to what shows the bug"),
  testPath: z
    .string()
    .max(500)
    .optional()
    .describe("The failing test or probe you wrote, relative to the repository root"),
});
export type FactoryReproductionReport = z.infer<typeof FactoryReproductionReport>;

/** `factory_submit_analysis`: the feature pipeline's Analyze step. */
export const FactoryAnalysisReport = z
  .object({
    decision: z.enum(["implement", "already_done", "needs_info", "out_of_scope"]),
    summary: z.string().trim().min(1).max(2_000).describe("Your conclusion, in a few sentences"),
    spec: z
      .string()
      .max(12_000)
      .optional()
      .describe("For `implement`: the spec you will build (API, behaviour, edge cases, docs)"),
    acceptanceCriteria: z
      .array(z.string().trim().min(1).max(500))
      .min(1)
      .max(12)
      .optional()
      .describe("For `implement`: testable acceptance criteria"),
  })
  .refine((r) => r.decision !== "implement" || (r.spec && r.acceptanceCriteria), {
    message: "`implement` needs a spec and acceptance criteria",
  });
export type FactoryAnalysisReport = z.infer<typeof FactoryAnalysisReport>;

/**
 * Where a feature's spec is in its approval (`FactoryTuning.specApproval`, software factory only):
 * `pending` (a person approves it or asks for changes before it is built), `approved` (the
 * builder implements it), `changes_requested` (the builder revises its analysis and submits it
 * again, which makes it `pending` once more).
 */
export const SpecApprovalState = z.enum(["pending", "approved", "changes_requested"]);
export type SpecApprovalState = z.infer<typeof SpecApprovalState>;

/** Longest feedback a person can give with a request for changes to a spec. */
export const SPEC_FEEDBACK_MAX = 4_000;

/** A feature's spec waiting for, or past, a person's approval before it is built. */
export const SpecApproval = z.object({
  state: SpecApprovalState,
  /** When the builder submitted the spec now on record (the latest version). */
  requestedAt: Timestamp,
  /** When it was decided; null while pending. */
  decidedAt: Timestamp.nullable().default(null),
  /**
   * Who decided: `user` (you, in Agent Rishi), or `auto` when approval was turned off (or the project
   * became a dark factory) while it waited. Null while pending.
   */
  by: z.enum(["user", "auto"]).nullable().default(null),
  /** What the person asked to change (with `changes_requested`, kept with the next version). */
  feedback: z.string().max(SPEC_FEEDBACK_MAX).nullable().default(null),
  /** Requests for changes so far. */
  rounds: z.int().nonnegative().default(0),
  /**
   * When the builder was sent the decision (the Implement step, or the changes asked for); null
   * until the loop sends it, which waits for a free agent.
   */
  sentAt: Timestamp.nullable().default(null),
});
export type SpecApproval = z.infer<typeof SpecApproval>;

/** Whether the item's spec stops it at Analyze: waiting for a person, or being revised. */
export function specHeld(item: { specApproval?: { state: string } | null }): boolean {
  const state = item.specApproval?.state;
  return state === "pending" || state === "changes_requested";
}

/**
 * The version of the spec a decision was made on: the `requestedAt` of the spec that was shown.
 * A decision on a spec revised since then is refused (409 `spec_changed`), so a stale page never
 * approves a spec nobody read. Without it, the decision applies to the spec on record.
 */
const SpecVersion = Timestamp.optional();

/** A person's decision on a spec that waits for approval. */
export const FactorySpecDecisionRequest = z.discriminatedUnion("decision", [
  z.object({ decision: z.literal("approve"), version: SpecVersion }),
  z.object({
    decision: z.literal("request_changes"),
    /** What to change, for the builder (and posted on the issue). */
    feedback: z.string().trim().min(1).max(SPEC_FEEDBACK_MAX),
    version: SpecVersion,
  }),
]);
export type FactorySpecDecisionRequest = z.infer<typeof FactorySpecDecisionRequest>;

/**
 * Where a work item is in its pipeline (what the dashboard diagram shows):
 * `intake` (waiting to be classified), `ignored` (untrusted author), `queued` (waiting for a
 * free agent), `reproduce` / `analyze` (first step of bugs and features; a feature whose spec
 * waits for a person's approval is still at `analyze`), `implement` (fix,
 * feature or docs change), `review` (merge checks and the independent review), `merge` (ready
 * for you, merging, or watching the default branch after it), `done`, `stopped`.
 */
export const PipelineStep = z.enum([
  "intake",
  "ignored",
  "queued",
  "reproduce",
  "analyze",
  "implement",
  "review",
  "merge",
  "done",
  "stopped",
]);
export type PipelineStep = z.infer<typeof PipelineStep>;

/** The fields of a work item that decide its step. */
export interface PipelineStepInput {
  stage: string;
  type: WorkType | null;
  investigation: Investigation | null;
  checks: Array<{ state: string }>;
  review: { verdict: string } | null;
  /** The spec's approval; a feature waiting on it is still at Analyze. */
  specApproval?: { state: string } | null;
}

/** Whether the item's merge checks all passed (none pending or failed). */
export function checksPassed(item: Pick<PipelineStepInput, "checks">): boolean {
  return (
    item.checks.length > 0 && item.checks.every((c) => c.state === "pass" || c.state === "skipped")
  );
}

/** The pipeline step of a work item, from its stage and what it has done so far. */
export function pipelineStep(item: PipelineStepInput): PipelineStep {
  switch (item.stage) {
    case "candidate":
      return "intake";
    case "ignored":
      return "ignored";
    case "backlog":
      return "queued";
    case "building":
      if (!item.investigation && item.type === "bug") return "reproduce";
      if (!item.investigation && item.type === "feature") return "analyze";
      // Its spec waits for a person, or is being revised at their request.
      if (specHeld(item)) return "analyze";
      return "implement";
    case "verifying":
      return checksPassed(item) ? "merge" : "review";
    case "watching":
    case "escalated":
      return "merge";
    case "merged":
      return "done";
    default:
      return "stopped";
  }
}

// ---------------------------------------------------------------- the dark factory's scout

/**
 * The scout's review areas: what its area reviewers look at, one long-lived reviewer session per
 * area. The code calls those sessions lenses; the UI, docs and prompts say "area reviewer".
 */
export const DiscoveryArea = z.enum([
  "features",
  "ux",
  "performance",
  "tech_debt",
  "test_gaps",
  "security",
  "bugs",
  "docs",
]);
export type DiscoveryArea = z.infer<typeof DiscoveryArea>;

/** One review area the scout asks for this round (`factory_plan_round`). */
export const ScoutLensRequest = z.object({
  area: DiscoveryArea,
  focus: z
    .string()
    .trim()
    .min(1)
    .max(1_000)
    .describe("What this area's reviewer should look at this round, specific to this app"),
});
export type ScoutLensRequest = z.infer<typeof ScoutLensRequest>;

/** `factory_plan_round`: the review areas for this round (none: the scout reviews by itself). */
export const FactoryPlanRoundRequest = z.object({
  lenses: z
    .array(ScoutLensRequest)
    .max(8)
    .describe(
      "The review areas for this round, one area reviewer each; empty to review by yourself",
    ),
});
export type FactoryPlanRoundRequest = z.infer<typeof FactoryPlanRoundRequest>;

/** One improvement an area reviewer found (`factory_report_findings`). */
export const FactoryFinding = z.object({
  title: z.string().trim().min(3).max(200),
  summary: z
    .string()
    .trim()
    .min(1)
    .max(4_000)
    .describe("What is wrong or missing, and why it matters for the vision"),
  type: WorkType,
  severity: z.enum(["high", "medium", "low"]).default("medium"),
  acceptanceCriteria: z.array(z.string().trim().min(1).max(500)).min(1).max(12),
  /** Paths the change would touch, when known. */
  paths: z.array(z.string()).max(50).optional(),
});
export type FactoryFinding = z.infer<typeof FactoryFinding>;
export type FactoryFindingInit = z.input<typeof FactoryFinding>;

/** A finding as the round keeps it, for the scout to decide on. */
export const ScoutFinding = FactoryFinding.extend({
  id: z.string().min(1),
  area: DiscoveryArea,
});
export type ScoutFinding = z.infer<typeof ScoutFinding>;

/** `factory_file_issue`: the scout files one piece of work as a GitHub issue. */
export const FactoryFileIssueRequest = z.object({
  title: z.string().trim().min(3).max(200),
  summary: z
    .string()
    .trim()
    .min(1)
    .max(8_000)
    .describe("The issue body: what and why, grounded in the vision"),
  type: WorkType,
  acceptanceCriteria: z.array(z.string().trim().min(1).max(500)).min(1).max(12),
  priority: z.enum(["high", "normal", "low"]).default("normal"),
  /** Findings this issue covers. */
  findingIds: z.array(z.string()).max(20).optional(),
});
export type FactoryFileIssueRequest = z.infer<typeof FactoryFileIssueRequest>;
export type FactoryFileIssueRequestInit = z.input<typeof FactoryFileIssueRequest>;

/** One area reviewer of the current round. */
export const ScoutLensRun = z.object({
  area: DiscoveryArea,
  focus: z.string(),
  sessionId: Id,
  sentAt: Timestamp,
  reported: z.boolean(),
  /** When it was reminded to report (once). */
  nudgedAt: Timestamp.nullable().default(null),
});
export type ScoutLensRun = z.infer<typeof ScoutLensRun>;

/**
 * The scout's plan for a round (`factory_plan_round`), recorded the moment it plans. Its area
 * reviewers start on the loop's next passes as agent slots free up, so planning never waits for
 * a session to start. A repeated plan call gets this plan back unchanged.
 */
export const ScoutPlan = z.object({
  /** When the scout planned. Area reviewers that haven't started 15 minutes later never do. */
  at: Timestamp,
  /** The review areas that get an area reviewer this round, in the scout's order. */
  lenses: z.array(ScoutLensRequest).default([]),
  /** Those whose area reviewer hasn't started yet: it waits for a free agent. */
  pending: z.array(DiscoveryArea).default([]),
  /** What the scout was told when it planned. */
  next: z.string(),
});
export type ScoutPlan = z.infer<typeof ScoutPlan>;

/**
 * One review round of the scout: `planning` (the scout picks review areas, then its area
 * reviewers wait for free agents), `reviewing` (the area reviewers work), `filing` (the scout
 * files the issues worth doing).
 */
export const ScoutRound = z.object({
  id: z.string().min(1),
  phase: z.enum(["planning", "reviewing", "filing"]),
  startedAt: Timestamp,
  /** When the scout was last sent work in this round (its turn must end after this). */
  sentAt: Timestamp,
  nudgedAt: Timestamp.nullable().default(null),
  /** The scout's plan; null until it plans. */
  plan: ScoutPlan.nullable().default(null),
  lenses: z.array(ScoutLensRun).default([]),
  findings: z.array(ScoutFinding).max(60).default([]),
  filed: z.int().nonnegative().default(0),
  /**
   * When the round began waiting to file: its reviewing is done, and it waits for the
   * work-in-progress limit (`maxOpenPrs`) to let go or for a free agent; nothing of it runs
   * meanwhile. Null while it isn't held.
   */
  heldSince: Timestamp.nullable().default(null),
  /**
   * Milliseconds the round spent held in earlier holds. Held time doesn't count against the
   * round's timeout, so a long hold never closes it before it files.
   */
  heldMs: z.int().nonnegative().default(0),
});
export type ScoutRound = z.infer<typeof ScoutRound>;

/** The scout of a dark factory: its long-lived sessions and the round in progress. */
export const ScoutState = z.object({
  sessionId: Id.nullable().default(null),
  /** One long-lived area reviewer session per area, reused round after round. */
  lensSessions: z.partialRecord(DiscoveryArea, Id).default({}),
  round: ScoutRound.nullable().default(null),
  lastRoundAt: Timestamp.nullable().default(null),
  /**
   * Why the last round closed before it ran its course, in plain words ("Couldn't start area
   * reviewers (ux): no free agent within 15 minutes."); null when it ran its course.
   */
  lastRoundNote: z.string().nullable().default(null),
  rounds: z.int().nonnegative().default(0),
});
export type ScoutState = z.infer<typeof ScoutState>;

/** The scout as the dashboard shows it. */
export const ScoutStatus = z.object({
  phase: z.enum(["idle", "planning", "reviewing", "filing"]),
  sessionId: Id.nullable(),
  /** The area reviewers of the current round, one per review area. */
  lenses: z.array(
    z.object({ area: DiscoveryArea, sessionId: Id, reported: z.boolean(), active: z.boolean() }),
  ),
  /** Review areas the scout planned whose area reviewer waits for a free agent. */
  waiting: z.array(DiscoveryArea).default([]),
  findings: z.int().nonnegative(),
  filed: z.int().nonnegative(),
  lastRoundAt: Timestamp.nullable(),
  /** Why the last round closed before it ran its course (`ScoutState.lastRoundNote`). */
  lastRoundNote: z.string().nullable().default(null),
  /**
   * When the next round may start (it also waits for the queue to run low); null while a round
   * runs, before the first one, and when scheduled rounds are off (`minBacklog` 0).
   */
  nextRoundAt: Timestamp.nullable(),
  rounds: z.int().nonnegative(),
  /**
   * Why "Run scout now" (`POST /api/projects/:id/factory/scout`) can't start a round right now,
   * in plain words; null when it can.
   */
  runNowBlockedBy: z.string().nullable().default(null),
  /**
   * Review follow-ups of merged PRs held for the scout's next rounds (#435), in the order its
   * brief lists them: by severity, then oldest first. At most `HELD_FOLLOW_UPS_MAX`.
   */
  heldFollowUps: z.array(HeldFollowUp).default([]),
});
export type ScoutStatus = z.infer<typeof ScoutStatus>;

// ---------------------------------------------------------------- your decisions

/** Let an ignored issue from an untrusted author in (it is never merged automatically). */
export const FactoryAdmitRequest = z.object({
  itemId: Id,
  /** Skip classification with a type you chose. */
  type: WorkType.optional(),
});
export type FactoryAdmitRequest = z.infer<typeof FactoryAdmitRequest>;

/** Correct the type of an item that has not started yet. */
export const FactorySetTypeRequest = z.object({
  itemId: Id,
  type: WorkType,
  reason: z.string().trim().max(500).optional(),
});
export type FactorySetTypeRequest = z.infer<typeof FactorySetTypeRequest>;

/**
 * Dismiss a failed item that holds no open pull request: it is marked `rejected` with the
 * reason (by default, that you dismissed it and why it had stopped).
 */
export const FactoryDismissRequest = z.object({
  reason: z.string().trim().min(1).max(500).optional(),
});
export type FactoryDismissRequest = z.infer<typeof FactoryDismissRequest>;
