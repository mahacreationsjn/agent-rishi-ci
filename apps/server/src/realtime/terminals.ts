import { randomUUID } from "node:crypto";
import {
  type EventOf,
  type RawEventEnvelope,
  type RunnerStream,
  TERMINAL_CONTROL_PREFIX,
  TerminalClientMessage,
  type TerminalQuery,
  type TerminalServerMessage,
} from "@agent-rishi/contracts";
import { defaultShell, shellSyntax } from "@agent-rishi/providers";
import type { WSContext, WSEvents } from "hono/ws";
import { errorMessage } from "../services/errors";
import { type RunnerDeps, type RunnerPort, runnerForSession } from "../services/runner-port";

export interface TerminalBridgeDeps extends RunnerDeps {
  /** Working directory for a new terminal: the session's worktree, else the Agent Rishi home. */
  cwdFor: (sessionId: string | undefined) => string;
  log?: (message: string) => void;
}

/**
 * Bridges UI terminal sockets (`/ws/pty`, §12.1) to runner terminals (`pty.*`). Terminals
 * live in the runner. Closing a socket detaches except for ephemeral login terminals, which close.
 * Output arrives as runner stream data and is fanned out to every attached socket.
 *
 * A session's terminal runs on the session's runner, any other on the home runner. The server
 * makes every pty id (`pty-<uuid>`), so ids are unique across runners and output, exits and
 * sockets stay keyed by pty id alone.
 */
export class TerminalBridge {
  private readonly sockets = new Map<string, Set<WSContext>>();
  /** The runner of each terminal opened or attached through this server. */
  private readonly runners = new Map<string, RunnerPort>();

  constructor(private readonly deps: TerminalBridgeDeps) {}

  handlers(query: TerminalQuery): WSEvents {
    let ptyId: string | undefined;
    let closed = false;
    const ephemeral = Boolean(query.ephemeral && query.command && !query.ptyId);
    return {
      onOpen: (_event, ws) => {
        // Set before `opened` is sent, so input the client sends right away is not dropped.
        void this.open(ws, query, (id) => {
          ptyId = id;
          if (closed && ephemeral) void this.release(id);
          else if (closed) this.sockets.get(id)?.delete(ws);
          return !closed;
        });
      },
      onMessage: (event, ws) => {
        if (!ptyId) return;
        let msg: TerminalClientMessage;
        try {
          msg = TerminalClientMessage.parse(JSON.parse(String(event.data)));
        } catch {
          return control(ws, { type: "error", message: "Invalid terminal message" });
        }
        void this.handle(ptyId, msg).catch((error: unknown) =>
          control(ws, { type: "error", message: errorMessage(error) }),
        );
      },
      onClose: (_event, ws) => {
        closed = true;
        if (!ptyId) return;
        if (ephemeral) void this.release(ptyId);
        else this.sockets.get(ptyId)?.delete(ws);
      },
    };
  }

  /** Runner stream data: terminal output goes to the attached sockets. */
  onStream(stream: RunnerStream): void {
    if (stream.kind !== "pty.output") return;
    for (const ws of this.sockets.get(stream.ptyId) ?? []) ws.send(stream.data);
  }

  /** Committed events: tell sockets when their terminal exits. */
  onEvents(events: RawEventEnvelope[]): void {
    for (const e of events) {
      if (e.type !== "pty.exited") continue;
      const { ptyId, exitCode } = (e as EventOf<"pty.exited">).payload;
      if (!this.sockets.get(ptyId)?.size) this.runners.delete(ptyId);
      for (const ws of this.sockets.get(ptyId) ?? [])
        control(ws, { type: "exited", ptyId, exitCode });
    }
  }

  private async open(
    ws: WSContext,
    query: TerminalQuery,
    onReady: (ptyId: string) => boolean,
  ): Promise<void> {
    let openingId: string | undefined;
    try {
      if (query.ptyId) {
        const runner = this.runners.get(query.ptyId) ?? this.runnerFor(query.sessionId);
        const attached = await runner.request({ name: "pty.attach", ptyId: query.ptyId });
        this.runners.set(query.ptyId, runner);
        this.attach(query.ptyId, ws);
        if (!onReady(query.ptyId)) return;
        control(ws, { type: "opened", ptyId: query.ptyId, pid: attached.pid, attached: true });
        if (attached.scrollback) ws.send(attached.scrollback);
        if (attached.exited) {
          control(ws, { type: "exited", ptyId: query.ptyId, exitCode: attached.exitCode });
        }
        return;
      }
      const ptyId = `pty-${randomUUID()}`;
      const runner = this.runnerFor(query.sessionId);
      openingId = ptyId;
      this.runners.set(ptyId, runner);
      this.attach(ptyId, ws);
      const command = query.ephemeral ? query.command : undefined;
      const opened = await runner.request({
        name: "pty.open",
        ptyId,
        cwd: this.deps.cwdFor(query.sessionId),
        cols: query.cols,
        rows: query.rows,
        ...(query.sessionId ? { sessionId: query.sessionId } : {}),
        ...(command ? commandShell(command) : {}),
      });
      openingId = undefined;
      if (!onReady(ptyId)) return;
      control(ws, { type: "opened", ptyId, pid: opened.pid, attached: false });
      if (query.command && !command)
        await runner.request({ name: "pty.input", ptyId, data: `${query.command}\r` });
    } catch (error) {
      if (openingId) {
        this.sockets.delete(openingId);
        this.runners.delete(openingId);
      }
      control(ws, { type: "error", message: errorMessage(error) });
      ws.close(1011, "terminal unavailable");
    }
  }

  private async release(ptyId: string): Promise<void> {
    const runner = this.runners.get(ptyId);
    this.sockets.delete(ptyId);
    this.runners.delete(ptyId);
    try {
      await runner?.request({ name: "pty.close", ptyId });
    } catch (error) {
      this.deps.log?.(`Could not close setup terminal: ${errorMessage(error)}`);
    }
  }

  private async handle(ptyId: string, msg: TerminalClientMessage): Promise<void> {
    const runner = this.runners.get(ptyId) ?? this.deps.runner;
    switch (msg.type) {
      case "input":
        await runner.request({ name: "pty.input", ptyId, data: msg.data });
        return;
      case "resize":
        await runner.request({ name: "pty.resize", ptyId, cols: msg.cols, rows: msg.rows });
        return;
      case "kill": {
        await runner.request({ name: "pty.close", ptyId });
        // A terminal closed on request reports no exit event of its own.
        for (const ws of this.sockets.get(ptyId) ?? []) {
          control(ws, { type: "exited", ptyId, exitCode: null });
        }
        this.sockets.delete(ptyId);
        this.runners.delete(ptyId);
        return;
      }
    }
  }

  /** The session's runner, or the home runner for a terminal outside any session. */
  private runnerFor(sessionId: string | undefined): RunnerPort {
    return sessionId ? runnerForSession(this.deps, sessionId) : this.deps.runner;
  }

  private attach(ptyId: string, ws: WSContext): void {
    const set = this.sockets.get(ptyId) ?? new Set();
    set.add(ws);
    this.sockets.set(ptyId, set);
  }
}

/** Start the command without an interactive shell prompt, so its completion ends the PTY. */
function commandShell(command: string): {
  shell: string;
  args: string[];
  env?: Record<string, string>;
} {
  const shell = defaultShell();
  switch (shellSyntax(shell)) {
    case "powershell":
      return {
        shell,
        args: ["-NoLogo", "-EncodedCommand", Buffer.from(command, "utf16le").toString("base64")],
      };
    case "cmd":
      // Keep cmd.exe's quoting out of node-pty's Windows argv escaping.
      return {
        shell,
        args: ["/d", "/s", "/c", "%RISHI_SETUP_COMMAND%"],
        env: { RISHI_SETUP_COMMAND: command },
      };
    case "posix":
      return { shell, args: ["-c", command] };
  }
}

function control(ws: WSContext, msg: TerminalServerMessage): void {
  ws.send(`${TERMINAL_CONTROL_PREFIX}${JSON.stringify(msg)}`);
}
