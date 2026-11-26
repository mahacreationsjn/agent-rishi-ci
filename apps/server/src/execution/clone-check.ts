import {
  describeUnpushedWork,
  hasUnpushedWork,
  type SandboxRef,
  type UnpushedWork,
  type WorktreeCleanupOutcome,
} from "@agent-rishi/contracts";
import { errorMessage } from "../services/errors";
import { type RunnerPort, runnerErrorCode } from "../services/runner-port";
import type { ExecutionBackend } from "./backend";

/**
 * What a sandbox's clone holds that exists nowhere else, checked before its container and volume
 * are deleted (#337, `docs/remote-runners.md` §5.2):
 * - `clean`: nothing, or no clone at all (a start that failed before it was made);
 * - `work`: uncommitted changes, unpushed commits or stashes;
 * - `unknown`: it couldn't be checked; `reason` says why.
 */
export type CloneCheck =
  | { kind: "clean" }
  | { kind: "work"; work: UnpushedWork }
  | { kind: "unknown"; reason: string };

export interface CloneCheckInput {
  /** The sandbox's runner. */
  runner: RunnerPort;
  docker: Pick<ExecutionBackend, "state" | "start">;
  ref: SandboxRef;
  /** The clone (the session's cwd). */
  cwd: string;
  /**
   * When the runner isn't connected: start its container if it stopped, and wait this long for
   * the runner to answer. 0 checks only a runner that is connected now.
   */
  wakeMs: number;
}

const CHECK_TIMEOUT_MS = 30_000;

/** Ask the sandbox's runner what exists only in its clone; never throws. */
export async function checkClone(input: CloneCheckInput): Promise<CloneCheck> {
  const unreachable = await reach(input);
  if (unreachable) return { kind: "unknown", reason: unreachable };
  try {
    const work = await input.runner.request(
      { name: "git.unpushed", cwd: input.cwd },
      CHECK_TIMEOUT_MS,
    );
    return hasUnpushedWork(work) ? { kind: "work", work } : { kind: "clean" };
  } catch (error) {
    if (runnerErrorCode(error) === "cwd_missing") return { kind: "clean" };
    return { kind: "unknown", reason: `Its clone couldn't be checked: ${errorMessage(error)}` };
  }
}

/** Null once the runner can answer; else why it can't. Starts a stopped container (`wakeMs`). */
async function reach({ runner, docker, ref, wakeMs }: CloneCheckInput): Promise<string | null> {
  if (runner.isConnected()) return null;
  const name = runner.describe?.() ?? "The sandbox's runner";
  if (wakeMs <= 0) return `${name} is not connected, so its clone couldn't be checked`;
  try {
    const state = await docker.state(ref);
    if (state === null)
      return `The container ${ref.container} is gone, so its clone couldn't be checked`;
    if (state === "exited") await docker.start(ref);
  } catch (error) {
    return `The container ${ref.container} couldn't be started to check its clone: ${errorMessage(error)}`;
  }
  if (await runner.waitForConnection(wakeMs)) return null;
  return `${name} didn't answer within ${Math.round(wakeMs / 1000)} s, so its clone couldn't be checked`;
}

/**
 * The archive outcome for a sandbox whose removal `check` decided on: kept (not forced, with
 * work or an unknown state), else removed with what was deleted with it.
 */
export function keptOutcome(check: CloneCheck): WorktreeCleanupOutcome | null {
  if (check.kind === "work") {
    return {
      status: "kept_changes",
      message: `The container's clone has ${describeUnpushedWork(check.work)}, so the container and its volume were kept`,
      unpushed: check.work,
    };
  }
  if (check.kind === "unknown") {
    return {
      status: "failed",
      message: `${check.reason}. The container and its volume were kept.`,
    };
  }
  return null;
}

/** What a forced removal deleted, for its outcome's message; null when nothing was at stake. */
export function deletedMessage(check: CloneCheck): string | null {
  if (check.kind === "work") {
    return `Deleted with the container: ${describeUnpushedWork(check.work)}`;
  }
  if (check.kind === "unknown") {
    return "Its clone couldn't be checked first, so anything it hadn't pushed was deleted with the container";
  }
  return null;
}
