import { mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { startAgent } from "../acp/process";
import type { AcpInitializeResult } from "../acp/protocol";
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
    const message = error instanceof Error ? error.message : String(error);
    return {
      acp: false,
      error: [message, stderr.trim().split(/\r?\n/).slice(-3).join(" ")]
        .filter(Boolean)
        .join(": ")
        .slice(0, 400),
    };
  }
}
