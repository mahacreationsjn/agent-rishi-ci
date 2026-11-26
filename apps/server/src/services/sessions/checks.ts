import {
  CHECK_MESSAGE_LIMIT,
  CHECK_MESSAGE_TAIL,
  type CheckResult,
  type CheckRunData,
  type CheckRunOutcome,
  checksOf,
  DEFAULT_CHECK_ROUNDS,
  type MessageSender,
  type Role,
  type Session,
  type SessionChecks,
  type UpdateSessionRequest,
  type UserInput,
} from "@agent-rishi/contracts";
import { readProjectConfig } from "../projects/project-config";

/**
 * Project checks (§9 Project checks): what a session freezes when it is created, how the loop
 * counts its rounds, and the words it uses on the card and to the agent. Pure apart from
 * `freezeChecks`, which reads the project's own `.agent-rishi/project.json`.
 */

/**
 * The checks a new session runs, read once from the project's own folder (never a session's
 * worktree, which its agent can edit) and frozen on the session. Null for role sessions and
 * when the project has none; the loop setting comes from the caller.
 */
export function freezeChecks(
  projectPath: string | null | undefined,
  role: Role,
  loop: { untilPass?: boolean; maxRounds?: number },
): SessionChecks | null {
  if (role !== "agent" || !projectPath) return null;
  const commands = checksOf(readProjectConfig(projectPath));
  if (commands.length === 0) return null;
  return {
    commands,
    untilPass: loop.untilPass ?? false,
    maxRounds: loop.maxRounds ?? DEFAULT_CHECK_ROUNDS,
  };
}

/**
 * The session's loop setting after a PATCH; the frozen commands never change. Switching the
 * loop on starts the round count again.
 */
export function withLoopSetting(
  checks: SessionChecks,
  req: Pick<UpdateSessionRequest, "untilChecksPass" | "checkRounds">,
): SessionChecks {
  const switchedOn = req.untilChecksPass === true && !checks.untilPass;
  return withRound(
    {
      ...checks,
      untilPass: req.untilChecksPass ?? checks.untilPass,
      maxRounds: req.checkRounds ?? checks.maxRounds,
    },
    switchedOn ? 0 : undefined,
  );
}

/**
 * The loop's round count once a message from `from` is on its way to the session (#412): the
 * loop's own message carries the round it starts (`checksRound`); Agent Rishi's other messages (an
 * automatic "continue", pull request feedback) keep the count, like Compact now, so no turn
 * Agent Rishi starts itself gives the loop more rounds; a message from anyone else (the user, a
 * PM, the factory) starts it again. Undefined when the count stays as it is.
 */
export function roundAfter(input: UserInput, from: MessageSender): number | undefined {
  if (input.checksRound !== undefined) return input.checksRound;
  if (from === "agent-rishi" || input.from === "agent-rishi") return undefined;
  return 0;
}

/**
 * `checks` with the round count set to `round` (undefined: as it is). A count that changes
 * clears the stop at the cap; an unchanged one returns `checks` itself.
 */
export function withRound(checks: SessionChecks, round: number | undefined): SessionChecks {
  if (round === undefined || ((checks.round ?? 0) === round && !checks.capReached)) return checks;
  const { round: _round, capReached: _capReached, ...rest } = checks;
  return round > 0 ? { ...rest, round } : rest;
}

/** Why the loop doesn't run after a turn of this session, or null when it does. */
export function loopSkipReason(session: Session): string | null {
  const checks = session.checks;
  if (session.role !== "agent") return "not an agent session";
  if (!checks?.untilPass || checks.commands.length === 0) return "loop off";
  if (session.autonomy === "read_only") return "read-only";
  if (session.planMode) return "planning";
  if (session.status !== "idle") return `status ${session.status}`;
  if (session.worktreeRemovedAt || session.archivedAt) return "no worktree";
  return null;
}

const failing = (c: CheckResult) => c.status === "failed" || c.status === "timed_out";

/** The checks of a finished run that failed or timed out. */
export function failingChecks(data: CheckRunData): CheckResult[] {
  return data.checks.filter(failing);
}

/** "12s", "1 min 5s", "850 ms". */
export function duration(ms: number | undefined): string {
  if (ms === undefined) return "";
  if (ms < 1000) return `${ms} ms`;
  const s = Math.round(ms / 1000);
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)} min${s % 60 ? ` ${s % 60}s` : ""}`;
}

/** How a check ended, for the agent: "failed (exit 1) after 12s", "timed out after 10 min". */
function ending(c: CheckResult): string {
  const after = c.durationMs === undefined ? "" : ` after ${duration(c.durationMs)}`;
  if (c.status === "timed_out") return `timed out${after}`;
  if (c.status === "passed") return `passed${after}`;
  return `failed (exit ${c.exitCode ?? "?"})${after}`;
}

/**
 * The `agent-rishi` message that sends failing checks back to the agent: each failing command, how
 * it ended and the end of its output (`CHECK_MESSAGE_TAIL` each, `CHECK_MESSAGE_LIMIT` in all),
 * which passed, and what to do. `round` is the round it starts, counted from 1.
 */
export function checksMessage(data: CheckRunData, round: number): string {
  const failed = failingChecks(data);
  const lines = [
    `Agent Rishi ran the project's checks after your last turn and ${failed.length} of ${data.checks.length} failed (round ${round} of ${data.maxRounds}). Fix what they report, then end your turn: Agent Rishi runs the checks again.`,
  ];
  let budget = CHECK_MESSAGE_LIMIT;
  for (const c of failed) {
    lines.push("", `\`${c.command}\` ${ending(c)}.`);
    const output = (c.output ?? "").trim();
    const take = Math.min(CHECK_MESSAGE_TAIL, Math.max(0, budget));
    // `slice(-0)` would be the whole output.
    const tail = take > 0 ? output.slice(-take) : "";
    if (!tail) {
      lines.push(output ? "(output left out: the message is long enough)" : "(no output)");
      continue;
    }
    budget -= tail.length;
    const cut = tail.length < output.length ? "The end of its output:" : "Its output:";
    // A fence longer than any run of backticks in the output, so the output can't close it.
    const fence = "`".repeat(Math.max(3, ...[...tail.matchAll(/`+/g)].map((m) => m[0].length + 1)));
    lines.push(cut, fence, tail, fence);
  }
  const passed = data.checks.filter((c) => c.status === "passed").map((c) => `\`${c.command}\``);
  if (passed.length > 0) lines.push("", `Passed: ${passed.join(", ")}.`);
  return lines.join("\n");
}

/** The card's one-line summary for a run in progress or ended with `outcome`. */
export function cardMessage(data: CheckRunData, outcome?: CheckRunOutcome): string {
  const total = data.checks.length;
  const failed = failingChecks(data).length;
  const noun = total === 1 ? "check" : "checks";
  switch (outcome) {
    case undefined: {
      const done = data.checks.filter((c) => c.status !== "pending" && c.status !== "running");
      return `Running ${total} ${noun} (${done.length} of ${total} done)`;
    }
    case "passed":
      return total === 1 ? "The check passed" : `All ${total} checks passed`;
    case "continuing":
      return `${failed} of ${total} ${noun} failed; sent to the agent (round ${data.round + 1} of ${data.maxRounds})`;
    case "cap_reached":
      return `${failed} of ${total} ${noun} still fail after ${data.maxRounds} ${data.maxRounds === 1 ? "round" : "rounds"}; Agent Rishi stopped`;
    case "stopped":
      return "Checks stopped";
    case "superseded":
      return "Checks stopped: a new message takes over";
    case "interrupted":
      return "Checks couldn't finish";
  }
}
