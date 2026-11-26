import {
  type McpServerEntry,
  type McpServerLiveState,
  type McpServerState,
  mcpServerNeedsAttention,
  type ProviderInfo,
  type Session,
} from "@agent-rishi/contracts";

/** Agent Rishi's own MCP server, as every provider names it. */
export const AGENT_RISHI_MCP_SERVER = "agent-rishi";

/** A server's live state in a few words. */
export const mcpStateLabel: Record<McpServerLiveState, string> = {
  connected: "connected",
  starting: "starting",
  failed: "failed",
  needs_sign_in: "needs sign-in",
  disabled: "disabled",
};

/** The dot shown beside a server's live state. */
export const mcpStateDot: Record<McpServerLiveState, string> = {
  connected: "bg-status-done",
  starting: "bg-status-running",
  failed: "bg-status-failed",
  needs_sign_in: "bg-status-waiting",
  disabled: "bg-status-idle",
};

/**
 * Whether the session's provider reports its MCP servers' live state (`capabilities.mcpStatus`,
 * Principle 5: never the provider's name).
 */
export const mcpStatusSupported = (provider: Pick<ProviderInfo, "capabilities"> | undefined) =>
  provider?.capabilities.mcpStatus === true;

/** One MCP server row of What's loaded: from config, from the provider, or both. */
export interface McpRow {
  key: string;
  name: string;
  /** Where it is configured (`built in` for Agent Rishi's own); absent when only the provider knew it. */
  scope?: string;
  /** The config file it is defined in. */
  file?: string;
  /** Its live state, when the provider reported one. */
  live?: McpServerState;
}

/**
 * The configured servers, each with its live state when the provider reported one, then the
 * servers the provider reported that config discovery didn't find (plugins, connectors). With
 * `live` null (no capability, or nothing reported yet) these are the config rows as they are.
 */
export function mcpRows(
  entries: readonly McpServerEntry[],
  live: readonly McpServerState[] | null | undefined,
): McpRow[] {
  const byName = new Map((live ?? []).map((s) => [s.name, s]));
  const rows: McpRow[] = entries.map((m) => {
    const state = byName.get(m.name);
    return {
      key: `${m.provider}:${m.scope}:${m.name}`,
      name: m.name,
      scope: m.provider === "agent-rishi" ? "built in" : m.scope,
      file: m.file,
      ...(state ? { live: state } : {}),
    };
  });
  const configured = new Set(entries.map((m) => m.name));
  for (const s of live ?? []) {
    if (!configured.has(s.name)) rows.push({ key: `live:${s.name}`, name: s.name, live: s });
  }
  return rows;
}

/** A row's tooltip: the config file and, for a server in trouble, the provider's error. */
export function mcpRowTitle(row: McpRow): string | undefined {
  const lines = [
    row.file,
    row.live && !row.file ? "Reported by the provider; not found in its config files" : undefined,
    row.live?.error,
  ].filter(Boolean);
  return lines.length > 0 ? lines.join("\n") : undefined;
}

/** Session statuses whose agent no longer runs: their MCP servers don't matter any more. */
const ENDED = new Set<Session["status"]>(["completed", "stopped"]);

/**
 * The servers of a live session whose tools the agent lacks and the user should hear about
 * (`mcpServerNeedsAttention`: failed, or waiting for sign-in, except an account connector or a
 * plugin's server, which What's loaded still lists), in the order the provider listed them.
 * Empty for a provider without `capabilities.mcpStatus`, an ended or archived session, or when
 * nothing was reported.
 */
export function mcpProblems(
  session: Pick<Session, "mcpServers" | "status" | "archivedAt">,
  supported: boolean,
): McpServerState[] {
  if (!supported || session.archivedAt || ENDED.has(session.status)) return [];
  return (session.mcpServers ?? []).filter(mcpServerNeedsAttention);
}
