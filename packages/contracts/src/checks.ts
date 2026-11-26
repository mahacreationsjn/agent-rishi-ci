import { z } from "zod";
import { ProjectCheck } from "./project-config";

/** Most automatic rounds a session may keep going for. */
export const MAX_CHECK_ROUNDS = 10;
/** Automatic rounds when none is chosen. */
export const DEFAULT_CHECK_ROUNDS = 3;
/** Characters of a check's output kept on its card (the end of it). */
export const CHECK_OUTPUT_LIMIT = 16_000;
/** Characters of one failing check's output quoted to the agent (the end of it). */
export const CHECK_MESSAGE_TAIL = 2_000;
/** Characters of failing output quoted to the agent in one message, all checks together. */
export const CHECK_MESSAGE_LIMIT = 12_000;

/** How many automatic rounds a session keeps going for. */
export const CheckRounds = z.int().min(1).max(MAX_CHECK_ROUNDS);

/**
 * A session's project checks (§9 Project checks). `commands` are frozen when the session is
 * created, read from the project's own folder, never from the session's worktree, so an agent
 * that edits `.agent-rishi/project.json` can't change what Agent Rishi runs for it. `untilPass`
 * ("Keep going until checks pass") runs them after each turn and sends failures back to the
 * agent, at most `maxRounds` times in a row.
 */
export const SessionChecks = z.object({
  /** The project's checks when the session was created, in order. */
  commands: z.array(ProjectCheck),
  /** Run the checks after each turn and continue the session while they fail. */
  untilPass: z.boolean(),
  /** Automatic rounds before Agent Rishi stops and leaves the session idle. */
  maxRounds: CheckRounds,
  /**
   * Automatic rounds Agent Rishi has sent since the count last started (absent: none). Only a
   * message from someone other than Agent Rishi, or switching the loop on, starts it again; turns
   * Agent Rishi starts itself (Compact now, an automatic "continue") keep it.
   */
  round: z.int().positive().optional(),
  /**
   * The checks still failed after the last round (`maxRounds`): the loop stopped, and runs no
   * checks after any turn until the count starts again.
   */
  capReached: z.boolean().optional(),
});
export type SessionChecks = z.infer<typeof SessionChecks>;

/** `NoticeItem.code` of a check run's card in the transcript; its `data` is `CheckRunData`. */
export const CHECK_RUN_NOTICE = "check_run";

/** The id of the card for the checks that ran after a turn: one run per turn. */
export function checkRunItemId(turnId: string): string {
  return `checks-${turnId}`;
}

/** Where one check of a run is. */
export const CheckStatus = z.enum([
  "pending",
  "running",
  "passed",
  "failed",
  "timed_out",
  "cancelled",
]);
export type CheckStatus = z.infer<typeof CheckStatus>;

/** One check of a run, as its card shows it. */
export const CheckResult = z.object({
  command: z.string().min(1),
  status: CheckStatus,
  /** Null until it exits, and when it was killed (timed out, cancelled). */
  exitCode: z.int().nullable(),
  durationMs: z.int().nonnegative().optional(),
  /** The end of its combined output, at most `CHECK_OUTPUT_LIMIT` characters. */
  output: z.string().max(CHECK_OUTPUT_LIMIT).optional(),
  /** The output was longer than what is kept. */
  truncated: z.boolean().optional(),
});
export type CheckResult = z.infer<typeof CheckResult>;

/**
 * How a check run ended:
 * - `passed`: every check passed, the loop ends;
 * - `continuing`: some failed, Agent Rishi sent them to the agent for another round;
 * - `cap_reached`: some still failed after `maxRounds` rounds, the session is left idle;
 * - `stopped`: the user pressed Stop;
 * - `superseded`: a new message arrived, which takes over from the loop;
 * - `interrupted`: the run couldn't finish (Agent Rishi restarted, the runner went away, the session
 *   was stopped or archived).
 */
export const CheckRunOutcome = z.enum([
  "passed",
  "continuing",
  "cap_reached",
  "stopped",
  "superseded",
  "interrupted",
]);
export type CheckRunOutcome = z.infer<typeof CheckRunOutcome>;

/**
 * `data` of a check run's card (`NoticeItem` with `code: CHECK_RUN_NOTICE`), added to the turn
 * the checks ran after. The item is `in_progress` while they run and `completed` once the
 * run has its `outcome`.
 */
export const CheckRunData = z.object({
  /** Automatic rounds before this run (`SessionChecks.round` when it started). */
  round: z.int().nonnegative(),
  maxRounds: CheckRounds,
  checks: z.array(CheckResult).min(1),
  /** Set once the run has ended. */
  outcome: CheckRunOutcome.optional(),
});
export type CheckRunData = z.infer<typeof CheckRunData>;
