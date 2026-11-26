import { type ChildProcess, type SpawnOptions, spawn } from "node:child_process";
import { isInside } from "../util/paths";
import { childEnv } from "./env";
import {
  isAlive,
  killProcess,
  killTree,
  killTreeAndOrphans,
  listDescendants,
  type ProcessLife,
} from "./tree";

/** A process the runner started (or adopted, like a pty shell). */
export interface TrackedProcess {
  pid: number;
  label: string;
  cwd: string;
}

export interface RunShellOptions {
  cwd: string;
  env?: Record<string, string>;
  /** Kill the process tree after this long. Default 30 minutes. */
  timeoutMs?: number;
  onOutput?: (chunk: string) => void;
  label?: string;
  /** Kill the process tree when this aborts; the result says `cancelled`. */
  signal?: AbortSignal;
  /**
   * Once the command's own process exits, also kill whatever it left running (a server or
   * watcher started in the background), instead of leaving it be. The result doesn't wait for
   * that: it may come a moment before they are gone.
   */
  endTree?: boolean;
}

/**
 * How long a command's output may stay open once its process has exited, while something it
 * started still holds it: then it is closed and the command counts as finished.
 */
const OUTPUT_GRACE_MS = 1_000;
/** How long after a kill the command may take to exit before it counts as finished anyway. */
const KILLED_GRACE_MS = 10_000;

export interface RunShellResult {
  exitCode: number | null;
  timedOut: boolean;
  /** Killed because `signal` aborted. */
  cancelled?: boolean;
}

/**
 * Tracks every child process the runner starts so they can be killed as whole process
 * trees: on stop, when their worktree is removed, and on runner shutdown. On POSIX,
 * children are spawned as process-group leaders so a group signal reaches grandchildren.
 */
export class ProcessSupervisor {
  private readonly tracked = new Map<number, TrackedProcess>();

  list(): TrackedProcess[] {
    return [...this.tracked.values()];
  }

  /** Track a process started elsewhere (pty shells). */
  adopt(proc: TrackedProcess): void {
    this.tracked.set(proc.pid, proc);
  }

  release(pid: number): void {
    this.tracked.delete(pid);
  }

  /** Spawn a tracked child. It is untracked automatically when it exits. */
  spawn(
    command: string,
    args: string[],
    opts: SpawnOptions & { cwd: string; label?: string },
  ): ChildProcess {
    const child = spawn(command, args, {
      ...opts,
      windowsHide: true,
      detached: process.platform !== "win32",
    });
    const pid = child.pid;
    if (pid !== undefined) {
      this.tracked.set(pid, { pid, label: opts.label ?? command, cwd: opts.cwd });
      child.once("exit", () => this.tracked.delete(pid));
    }
    return child;
  }

  /**
   * Run a shell command line, streaming combined output. Never rejects for exit codes. It
   * finishes when its output closes, or shortly after its own process exits while something it
   * started keeps the output open (`OUTPUT_GRACE_MS`), so a process left in the background can't
   * hold it up; `endTree` kills those meanwhile, without holding it up either. The timeout and
   * `signal` kill the whole tree, also once the shell has exited.
   */
  runShell(command: string, opts: RunShellOptions): Promise<RunShellResult> {
    return new Promise((resolveResult) => {
      // Tells what the shell started from what an earlier process with its pid did.
      const life: ProcessLife = { startedAt: Date.now() };
      const child = this.spawn(command, [], {
        cwd: opts.cwd,
        shell: true,
        env: { ...childEnv(), ...opts.env },
        stdio: ["ignore", "pipe", "pipe"],
        label: opts.label ?? command,
      });
      let timedOut = false;
      let cancelled = false;
      let exited = false;
      let exitCode: number | null = null;
      let settled = false;
      let grace: NodeJS.Timeout | undefined;
      const settle = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        clearTimeout(grace);
        opts.signal?.removeEventListener("abort", onAbort);
        resolveResult({ exitCode, timedOut, ...(cancelled ? { cancelled } : {}) });
      };
      /** Stop waiting for the output after `ms`, reading what has already arrived first. */
      const closeAfter = (ms: number) => {
        if (settled) return;
        clearTimeout(grace);
        grace = setTimeout(
          () =>
            setImmediate(() => {
              if (settled) return;
              child.stdout?.destroy();
              child.stderr?.destroy();
              settle();
            }),
          ms,
        );
      };
      // The shell, what runs under it, and what lost its parent there (`killTreeAndOrphans`).
      const endTree = () =>
        child.pid === undefined
          ? Promise.resolve()
          : killTreeAndOrphans(child.pid, { ...life }).catch(() => undefined);
      const kill = () => {
        void endTree().then(() => closeAfter(exited ? OUTPUT_GRACE_MS : KILLED_GRACE_MS));
      };
      const timer = setTimeout(
        () => {
          timedOut = true;
          kill();
        },
        opts.timeoutMs ?? 30 * 60_000,
      );
      const onAbort = () => {
        cancelled = true;
        kill();
      };
      if (opts.signal?.aborted) onAbort();
      else opts.signal?.addEventListener("abort", onAbort, { once: true });
      const onData = (data: Buffer) => opts.onOutput?.(data.toString("utf8"));
      child.stdout?.on("data", onData);
      child.stderr?.on("data", onData);
      child.once("error", (error) => {
        opts.onOutput?.(`${error.message}\n`);
        settle();
      });
      child.once("exit", (code) => {
        exited = true;
        life.endedAt = Date.now();
        exitCode = code;
        // Not awaited: finding what it left running lists every process, on Windows a PowerShell
        // CIM query of a second or two, which a command that left nothing must not wait for.
        if (opts.endTree) void endTree();
        closeAfter(OUTPUT_GRACE_MS);
      });
      child.once("close", (code) => {
        exitCode = code ?? exitCode;
        settle();
      });
    });
  }

  /** Kill the trees of tracked processes whose cwd is inside `dir` (before removing it). */
  async killUnder(dir: string): Promise<void> {
    const victims = this.list().filter((p) => isInside(dir, p.cwd));
    await Promise.all(victims.map((p) => this.kill(p.pid)));
  }

  async kill(pid: number): Promise<void> {
    await killTree(pid);
    if (!isAlive(pid)) this.tracked.delete(pid);
  }

  /**
   * Kill every tracked tree. With `sweepDescendants`, also kill any remaining descendant of
   * this process (provider processes started by adapters), so a clean shutdown of the
   * runner process leaves nothing behind. Not used when the runner is embedded (tests).
   */
  async killAll(sweepDescendants = false): Promise<void> {
    await Promise.all(this.list().map((p) => this.kill(p.pid)));
    if (!sweepDescendants) return;
    const rest = await listDescendants(process.pid).catch(() => [] as number[]);
    // Each was found, checked by start time on Windows (`treeIn`), so it's ended on its own there:
    // `taskkill /T` would follow parent ids that may belong to an earlier process.
    await Promise.all(
      rest.map((pid) => (process.platform === "win32" ? killProcess(pid) : killTree(pid, 500))),
    );
  }
}
