import { existsSync } from "node:fs";
import {
  CHECK_OUTPUT_LIMIT,
  type RunnerCommandOf,
  type RunnerCommandResult,
} from "@agent-rishi/contracts";
import { CommandError } from "../errors";
import { cwdMissing } from "../git/exec";
import type { ProcessSupervisor } from "../process/supervisor";

/**
 * A session's project checks (§9 Project checks), run one at a time per session at the
 * server's request: `check.run` runs a command in the session's folder and answers with how it
 * ended and the end of its output; `check.cancel` (and `session.stop`) kills it. A check ends
 * when its own process exits, taking what it left running in the background with it
 * (`RunShellOptions.endTree`, which its result doesn't wait for); its timeout and `check.cancel`
 * always end it and free the session's slot. The server decides what runs, from the checks it
 * froze on the session; nothing here reads `.agent-rishi/project.json`.
 */
export class CheckRunner {
  private readonly running = new Map<string, AbortController>();

  constructor(
    private readonly supervisor: ProcessSupervisor,
    private readonly env: NodeJS.ProcessEnv = process.env,
  ) {}

  async run(cmd: RunnerCommandOf<"check.run">): Promise<RunnerCommandResult<"check.run">> {
    if (!existsSync(cmd.cwd)) throw cwdMissing(cmd.cwd);
    if (this.running.has(cmd.sessionId)) {
      throw new CommandError("check_running", "A check is already running for this session");
    }
    const abort = new AbortController();
    this.running.set(cmd.sessionId, abort);
    const started = Date.now();
    let output = "";
    let total = 0;
    try {
      const result = await this.supervisor.runShell(cmd.command, {
        cwd: cmd.cwd,
        timeoutMs: cmd.timeoutMs,
        // Like an agent's shell (§4.2): tools behave as in CI and never wait on a prompt.
        env: cmd.ciEnv === false ? {} : { CI: this.env.CI || "true" },
        label: `check: ${cmd.command}`,
        signal: abort.signal,
        // A server or watcher a check leaves behind goes with it, and can't hold up its end.
        endTree: true,
        onOutput: (chunk) => {
          total += chunk.length;
          output = (output + chunk).slice(-CHECK_OUTPUT_LIMIT);
        },
      });
      const killed = result.timedOut || result.cancelled === true;
      return {
        exitCode: killed ? null : result.exitCode,
        timedOut: result.timedOut && result.cancelled !== true,
        cancelled: result.cancelled === true,
        durationMs: Date.now() - started,
        output,
        truncated: total > output.length,
      };
    } finally {
      if (this.running.get(cmd.sessionId) === abort) this.running.delete(cmd.sessionId);
    }
  }

  /** Kill the session's running check; false when none runs. */
  cancel(sessionId: string): boolean {
    const abort = this.running.get(sessionId);
    if (!abort) return false;
    abort.abort();
    return true;
  }
}
