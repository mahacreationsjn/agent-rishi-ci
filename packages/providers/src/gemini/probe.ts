import { mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { startAgent } from "../acp/process";
import type { AcpInitializeResult, AcpSessionSetup } from "../acp/protocol";
import { AcpRpcError, METHOD_NOT_FOUND } from "../acp/rpc";
import type { ResolvedCommand } from "../util/exec";

/** The arguments that start Gemini CLI's ACP server. */
export const GEMINI_ACP_ARGS = ["--acp"] as const;

/** What a short-lived `gemini --acp` showed. */
export interface GeminiProbe {
  /** The CLI answered `initialize` with ACP version 1. */
  acp: boolean;
  /** What it reported in `initialize` (its capabilities). */
  info?: AcpInitializeResult;
  /** Why the ACP server didn't start, when it didn't. */
  error?: string;
}

/** A folder of Agent Rishi's own to run the probe in, so it never touches a project. */
function scratchDir(): string {
  const dir = path.join(tmpdir(), "agent-rishi-gemini-probe");
  try {
    mkdirSync(dir, { recursive: true });
  } catch {
    // The probe still runs, in the runner's own folder.
  }
  return dir;
}

/**
 * Start `gemini --acp` once and check it answers `initialize` with ACP version 1. Only the
 * handshake runs: no `authenticate` (it would rewrite the user's Gemini settings), no session
 * (that would save a session file and start the user's MCP servers and hooks), no model call.
 * Never throws.
 */
export async function probeGemini(
  exe: ResolvedCommand,
  opts: { timeoutMs?: number } = {},
): Promise<GeminiProbe> {
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
        args: GEMINI_ACP_ARGS,
        label: "Gemini CLI",
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

/** What a short-lived `gemini --acp` session reported about the account's models. */
export interface GeminiModelListing {
  info?: AcpInitializeResult;
  /** The `session/new` result: its `models` list the account's models. */
  setup?: AcpSessionSetup;
  /** Why no list came back, when none did. */
  error?: string;
}

/**
 * Gemini CLI lists the account's models only in a session (`models.availableModels`), so open
 * one just for that, in Agent Rishi's own scratch folder, with none of Agent Rishi's MCP servers
 * and no `authenticate` (it would rewrite the login method in the user's settings): a CLI that
 * can't use its login fails `session/new`. No prompt is sent, so no model is called and no
 * token is spent. The session is closed and the process stopped at once. Only run it when there
 * is evidence of a login (`readGeminiAuth`), so a signed-out CLI is never asked to sign in.
 * Never throws.
 */
export async function listGeminiModels(
  exe: ResolvedCommand,
  opts: { timeoutMs?: number } = {},
): Promise<GeminiModelListing> {
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
      { args: GEMINI_ACP_ARGS, label: "Gemini CLI", cwd, timeoutMs },
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
      () => reject(new Error(`Gemini CLI did not answer within ${ms / 1000}s`)),
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
