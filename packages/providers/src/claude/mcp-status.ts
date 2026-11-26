import {
  type McpServerLiveState,
  type McpServerOrigin,
  type McpServerState,
  mcpServerError,
} from "@agent-rishi/contracts";

/** Claude Code's MCP server statuses (`system/init` `mcp_servers`, `mcpServerStatus()`). */
const STATES: Record<string, McpServerLiveState> = {
  connected: "connected",
  pending: "starting",
  failed: "failed",
  "needs-auth": "needs_sign_in",
  disabled: "disabled",
};

/**
 * Where Claude Code says a server's definition came from (`source`, or the older `scope`):
 * `claudeai` is a connector of the user's claude.ai account, `plugin` a plugin's server, `sdk`
 * one the program running the agent registered in-process; the rest are config scopes
 * (`dynamic` is the session's `--mcp-config`, `agent` a subagent's own servers).
 */
const ORIGINS: Record<string, McpServerOrigin> = {
  claudeai: "account",
  plugin: "plugin",
  sdk: "host",
  user: "config",
  project: "config",
  local: "config",
  dynamic: "config",
  managed: "config",
  enterprise: "config",
  agent: "config",
};

function origin(raw: Record<string, unknown>): McpServerOrigin | undefined {
  for (const field of [raw.source, raw.scope]) {
    if (typeof field === "string" && Object.hasOwn(ORIGINS, field)) return ORIGINS[field];
  }
  return undefined;
}

/**
 * The MCP servers Claude Code reports for a session, as live states: `system/init`'s
 * `mcp_servers` (name, status and source) or `mcpServerStatus()` (with the error of a failed
 * server). Only names, states, origins and the clipped, masked error are kept: never a
 * server's config. Entries with no name or an unknown status are left out; the first entry of
 * a name wins. A report that doesn't say where a server comes from (an older CLI) keeps the
 * origin `before` knew, and a server still failed keeps its error (init carries none).
 */
export function toMcpServerStates(
  list: unknown,
  before: readonly McpServerState[] = [],
): McpServerState[] {
  if (!Array.isArray(list)) return [];
  const known = new Map(before.map((s) => [s.name, s]));
  const out: McpServerState[] = [];
  const seen = new Set<string>();
  for (const raw of list as Record<string, unknown>[]) {
    const name = typeof raw?.name === "string" ? raw.name.trim().slice(0, 200) : "";
    const state = typeof raw?.status === "string" ? STATES[raw.status] : undefined;
    if (!name || !state || seen.has(name)) continue;
    seen.add(name);
    const prior = known.get(name);
    const from = origin(raw) ?? prior?.origin;
    const error =
      state === "failed"
        ? (mcpServerError(raw.error) ?? (prior?.state === "failed" ? prior.error : undefined))
        : undefined;
    out.push({ name, state, ...(from ? { origin: from } : {}), ...(error ? { error } : {}) });
  }
  return out;
}
