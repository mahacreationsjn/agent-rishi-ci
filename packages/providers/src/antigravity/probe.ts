import { mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { startAgent } from "../acp/process";
import type { AcpInitializeResult, AcpSessionSetup } from "../acp/protocol";
import { AcpRpcError, METHOD_NOT_FOUND } from "../acp/rpc";
import type { ResolvedCommand } from "../util/exec";

/**
 * The arguments that start Antigravity CLI's ACP server. `--process-per-session` is required:
 * without it `initialize` reports no MCP support, and Agent Rishi's tools are an HTTP MCP server.
 */
export const AGY_ACP_ARGS = ["acp", "--process-per-session", "--disable-telemetry"] as const;

/** What a short-lived `agy acp` showed. */
export interface AgyProbe {
  /** The CLI answered `initialize` with ACP version 1. */
  acp: boolean;
  info?: AcpInitializeResult;
  /** Why the ACP server didn't start, when it didn't. */
  error?: string;
}

/** A folder of Agent Rishi's own to run the probe in, so it never touches a project. */
function scratchDir(): string {
  const dir = path.join(tmpdir(), "agent-rishi-agy-probe");
  try {
    mkdirSync(dir, { recursive: true });
  } catch {
    // The probe still runs, in the runner's own folder.
  }
  return dir;
}

/**
 * Start `agy acp` once and check it answers `initialize` with ACP version 1. Only the handshake
 * runs: no session (that would start the user's MCP servers and plugins), no model call. Never
 * throws.
 */
export async function probeAgy(
  exe: ResolvedCommand,
  opts: { timeoutMs?: number } = {},
): Promise<AgyProbe> {
  let stderr = "";
  try {
    const started = await startAgent(
      exe,
      {
        onNotification: () => {},
        onRequest: async () => {
          throw new AcpRpcError(METHOD_NOT_FOUND, "not supported");
        },
        onExit: (_code, tail) => {
          stderr = tail;
        },
      },
      {
        args: AGY_ACP_ARGS,
        label: "Antigravity CLI",
        cwd: scratchDir(),
        timeoutMs: opts.timeoutMs ?? 20_000,
      },
    );
    await started.rpc.close();
    return { acp: true, info: started.info };
  } catch (error) {
    return { acp: false, error: failure(error, stderr) };
  }
}

/** What a short-lived `agy acp` session reported about the account's models. */
export interface AgyModelListing {
  info?: AcpInitializeResult;
  /** The `session/new` result: its `model` and `thought_level` options list the models. */
  setup?: AcpSessionSetup;
  /** Why no list came back, when none did. */
  error?: string;
}

/**
 * Antigravity CLI lists the account's models only in a session, so open one just for that: in
 * Agent Rishi's own scratch folder, with its strict settings (`--cli_dir_name`), no MCP servers of
 * Agent Rishi's and no `authenticate` (a signed-out CLI fails `session/new`; no browser login
 * opens). No prompt is sent, so no model is called. The session is closed and the process
 * stopped at once. Never throws.
 */
export async function listAgyModels(
  exe: ResolvedCommand,
  opts: { cliDir?: string; timeoutMs?: number } = {},
): Promise<AgyModelListing> {
  const timeoutMs = opts.timeoutMs ?? 30_000;
  const cwd = scratchDir();
  let stderr = "";
  let started: Awaited<ReturnType<typeof startAgent>> | undefined;
  try {
    started = await startAgent(
      exe,
      {
        onNotification: () => {},
        onRequest: async () => {
          throw new AcpRpcError(METHOD_NOT_FOUND, "not supported");
        },
        onExit: (_code, tail) => {
          stderr = tail;
        },
      },
      {
        args: [...AGY_ACP_ARGS, ...(opts.cliDir ? ["--cli_dir_name", opts.cliDir] : [])],
        label: "Antigravity CLI",
        cwd,
        timeoutMs,
      },
    );
    const { rpc, info } = started;
    const setup = await withTimeout(
      rpc.request<AcpSessionSetup>("session/new", { cwd, mcpServers: [] }),
      timeoutMs,
    );
    if (setup?.sessionId && info.agentCapabilities?.sessionCapabilities?.close) {
      await withTimeout(rpc.request("session/close", { sessionId: setup.sessionId }), 5_000).catch(
        () => undefined,
      );
    }
    return { info, setup: setup ?? {} };
  } catch (error) {
    return { ...(started ? { info: started.info } : {}), error: failure(error, stderr) };
  } finally {
    await started?.rpc.close();
  }
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new Error(`Antigravity CLI did not answer within ${ms / 1000}s`)),
      ms,
    );
    timer.unref?.();
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

/** An error and the last lines the CLI printed, short enough for a status line. */
function failure(error: unknown, stderr: string): string {
  const message = error instanceof Error ? error.message : String(error);
  return [message, stderr.trim().split(/\r?\n/).slice(-3).join(" ")]
    .filter(Boolean)
    .join(": ")
    .slice(0, 400);
}
