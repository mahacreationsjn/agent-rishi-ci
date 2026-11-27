import { type ChildProcess, fork } from "node:child_process";
import { closeSync, mkdirSync, openSync, renameSync, statSync } from "node:fs";
import { dirname } from "node:path";

/** The server log is moved aside to `<file>.1` (one copy kept) when it grows past this. */
const LOG_LIMIT_BYTES = 5 * 1024 * 1024;

/**
 * Keep the server log from growing without bound: past `limit` it becomes `<file>.1`
 * (replacing an older one) and a fresh file starts. Never throws.
 */
export function rotateLog(file: string, limit = LOG_LIMIT_BYTES): void {
  try {
    if (statSync(file).size > limit) renameSync(file, `${file}.1`);
  } catch {
    // No log yet, or it is in use: append to it as it is.
  }
}

import {
  type DesktopHostMessage,
  DesktopServerMessage,
  type DesktopUpdateCommand,
} from "@agent-rishi/contracts";
import { loginShellPath } from "./login-shell-path";

export interface ServerReady {
  url: string;
  port: number;
  launchUrl: string;
  version: string;
}

export class ServerStartError extends Error {
  constructor(
    message: string,
    readonly code: string | null,
  ) {
    super(message);
  }
}

export interface ServerExit {
  code: number | null;
  signal: NodeJS.Signals | null;
  reason: "stopped" | "expected" | "unexpected" | "startup";
}

export interface ServerProcessOptions {
  /** `dist/server.js`. */
  entry: string;
  home: string;
  port: number;
  fake: boolean;
  /** Server output goes here (`<home>/logs/desktop-server.log`). */
  logFile: string;
  /** The server asks the updater to do something; answer with `send({ type: "update.done" })`. */
  onUpdateCommand: (id: string, command: DesktopUpdateCommand) => void;
  /** Put the newest database backup in place before starting (the Restore button). */
  restoreNewestBackup?: boolean;
  /** How long the child can take to report readiness. Defaults to 60 seconds. */
  startupTimeoutMs?: number;
  onExit?: (exit: ServerExit) => void;
  /** The process exited without being asked to (crash, or `agent-rishi stop` from a terminal). */
  onUnexpectedExit: (code: number | null) => void;
  log: (message: string) => void;
}

/**
 * The server the app starts (§17): `dist/server.js` forked on the app's own binary as Node.js
 * (Electron's `fork` sets `ELECTRON_RUN_AS_NODE` and, on macOS, uses the helper binary so no
 * second dock icon appears). It is a normal child: when the app goes away it closes, while
 * the detached runner it started keeps the agents running.
 */
export class ServerProcess {
  private child: ChildProcess | undefined;
  private stopping = false;

  constructor(private readonly opts: ServerProcessOptions) {}

  get pid(): number | undefined {
    return this.child?.pid;
  }

  async start(): Promise<ServerReady> {
    // A Dock or Finder launch has launchd's minimal PATH: hand the server the login shell's.
    const loginPath = await loginShellPath();
    mkdirSync(dirname(this.opts.logFile), { recursive: true });
    rotateLog(this.opts.logFile);
    const out = openSync(this.opts.logFile, "a");
    const args = ["--home", this.opts.home, "--port", String(this.opts.port)];
    if (this.opts.fake) args.push("--fake");
    if (this.opts.restoreNewestBackup) args.push("--restore-newest-backup");
    let child: ChildProcess;
    try {
      child = fork(this.opts.entry, args, {
        stdio: ["ignore", out, out, "ipc"],
        env: {
          ...process.env,
          ...(loginPath ? { PATH: loginPath } : {}),
          AGENT_RISHI_DEPS_INSTALLER: "registry",
        },
        windowsHide: true,
      });
    } finally {
      closeSync(out);
    }
    this.child = child;
    this.opts.log(`server: started pid ${child.pid} (port ${this.opts.port})`);

    return new Promise<ServerReady>((resolve, reject) => {
      let ready = false;
      let settled = false;
      const fail = (message: string, code: string | null = null) => {
        if (settled) return;
        settled = true;
        clearTimeout(deadline);
        reject(new ServerStartError(message, code));
      };
      const deadline = setTimeout(() => {
        fail("The server exceeded its startup deadline");
        child.kill("SIGKILL");
      }, this.opts.startupTimeoutMs ?? 60_000);
      child.on("error", (error: NodeJS.ErrnoException) => {
        this.opts.log(`server: child process error (${error.code ?? "unknown"})`);
        if (!ready) fail("The server child process failed", error.code ?? null);
      });
      child.on("message", (raw) => {
        const parsed = DesktopServerMessage.safeParse(raw);
        if (!parsed.success) return;
        const message = parsed.data;
        if (message.type === "ready" && !settled) {
          settled = true;
          clearTimeout(deadline);
          ready = true;
          resolve(message);
        } else if (message.type === "failed" && !ready) {
          fail(message.message, message.code);
        } else if (message.type === "update.command") {
          this.opts.onUpdateCommand(message.id, message.command);
        }
      });
      child.once("close", (code, signal) => {
        const reason = this.stopping
          ? "expected"
          : !ready
            ? "startup"
            : code === 0
              ? "stopped"
              : "unexpected";
        this.opts.log(`server: exited (code ${code}, signal ${signal}, reason ${reason})`);
        this.child = undefined;
        this.opts.onExit?.({ code, signal, reason });
        if (!ready) fail(`The server exited before it started (code ${code}, signal ${signal})`);
        else if (!this.stopping) this.opts.onUnexpectedExit(code);
      });
    });
  }

  send(message: DesktopHostMessage): void {
    if (this.child?.connected) {
      this.child.send(message, (error) => {
        if (error) this.opts.log("server: could not send an IPC message");
      });
    }
  }

  /**
   * Close the server; with `stopRunner` the runner drains and exits too (as `agent-rishi stop`),
   * so an update can replace the files it runs from. A server that doesn't exit in time gets
   * SIGTERM (which ends a stuck close), then SIGKILL, so quitting the app never hangs on it.
   */
  async stop(opts: { stopRunner: boolean; timeoutMs?: number; graceMs?: number }): Promise<void> {
    const child = this.child;
    if (!child) return;
    this.stopping = true;
    const grace = opts.graceMs ?? KILL_GRACE_MS;
    const exited = new Promise<void>((resolve) => child.once("close", () => resolve()));
    this.send({ type: "shutdown", stopRunner: opts.stopRunner });
    if (await settlesWithin(exited, opts.timeoutMs ?? 20_000)) return;
    this.opts.log("server: did not exit in time; stopping it");
    child.kill();
    if (await settlesWithin(exited, grace)) return;
    this.opts.log("server: still running; killing it");
    child.kill("SIGKILL");
    if (!(await settlesWithin(exited, grace))) this.opts.log("server: did not exit after SIGKILL");
  }
}

/** How long a server gets after SIGTERM, and again after SIGKILL. */
const KILL_GRACE_MS = 5_000;

/** True when `promise` settles within `ms`; never waits longer. */
async function settlesWithin(promise: Promise<void>, ms: number): Promise<boolean> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<false>((resolve) => {
    timer = setTimeout(() => resolve(false), ms);
    timer.unref();
  });
  try {
    return await Promise.race([promise.then(() => true as const), timeout]);
  } finally {
    clearTimeout(timer);
  }
}
