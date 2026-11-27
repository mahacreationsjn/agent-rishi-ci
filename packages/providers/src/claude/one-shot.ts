import { tmpdir } from "node:os";
import type { ResolvedCommand } from "../util/exec";
import { explicitModel } from "../util/model";
import { str } from "../util/text";
import { type OneShotRequest, oneShotSignal, type UtilityModel } from "../utility";
import { claudeEnv, executableOptions } from "./options";
import { loadClaudeSdk } from "./sdk";

/**
 * Why a one-shot's `result` message failed. An error the CLI reports as a turn (a usage limit, an
 * API error) arrives as `subtype: "success"` with `is_error` and the reason in `result`; other
 * failures carry it in `errors`. Without the reason the log said only "failed: success".
 */
export function oneShotFailure(message: {
  subtype?: string;
  is_error?: boolean;
  result?: unknown;
  errors?: unknown;
}): string {
  const errors = Array.isArray(message.errors)
    ? message.errors.filter((e): e is string => typeof e === "string" && e.trim() !== "")
    : [];
  const result = typeof message.result === "string" ? message.result.trim() : "";
  const reason = [...errors, ...(result ? [result] : [])].join("; ").replace(/\s+/g, " ");
  const kind = message.subtype && message.subtype !== "success" ? message.subtype : "error";
  return `Utility model failed (${kind})${reason ? `: ${reason.slice(0, 300)}` : ""}`;
}

/** Default utility model: the CLI's small-model alias. */
export const CLAUDE_UTILITY_MODEL = "haiku";

/**
 * One-shot Claude call for the utility model: one turn, no tools, no MCP servers, no settings
 * or hooks loaded, nothing persisted.
 */
export class ClaudeUtilityModel implements UtilityModel {
  readonly providerId = "claude";
  readonly defaultModel = CLAUDE_UTILITY_MODEL;

  constructor(private readonly resolveExecutable: () => ResolvedCommand | undefined) {}

  async runOneShot(request: OneShotRequest): Promise<string> {
    const exe = this.resolveExecutable();
    if (!exe) throw new Error("Claude Code is not installed");
    const { signal, dispose } = oneShotSignal(request);
    const abortController = new AbortController();
    signal.addEventListener("abort", () => abortController.abort(), { once: true });
    try {
      const { query } = await loadClaudeSdk();
      const q = query({
        prompt: request.prompt,
        options: {
          ...executableOptions(exe),
          cwd: tmpdir(),
          model: explicitModel(request.model) ?? CLAUDE_UTILITY_MODEL,
          maxTurns: 1,
          tools: [],
          mcpServers: {},
          strictMcpConfig: true,
          settingSources: [],
          persistSession: false,
          permissionMode: "dontAsk",
          thinking: { type: "disabled" },
          ...(request.system ? { systemPrompt: request.system } : {}),
          env: claudeEnv(undefined),
          abortController,
        },
      });
      let text = "";
      for await (const message of q) {
        if (message.type === "assistant" && !message.parent_tool_use_id) {
          for (const block of message.message.content) {
            if (block.type === "text") text += block.text;
          }
        }
        if (message.type === "result") {
          if (message.subtype !== "success" || message.is_error) {
            throw new Error(oneShotFailure(message));
          }
          return (str(message, "result") ?? text).trim();
        }
      }
      if (signal.aborted)
        throw signal.reason instanceof Error ? signal.reason : new Error("Aborted");
      return text.trim();
    } finally {
      dispose();
    }
  }
}
