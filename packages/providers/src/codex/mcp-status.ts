import {
  type AgentEvent,
  type McpServerLiveState,
  type McpServerState,
  mcpServerError,
  sameMcpServers,
} from "@agent-rishi/contracts";
import type { McpServerStatusUpdatedNotification } from "./protocol/v2";

/**
 * One `mcpServer/startupStatus/updated` as a live state: `ready` is connected, `failed` with
 * `reauthenticationRequired` needs sign-in, `cancelled` is disabled. Only the name, the state
 * and the clipped, masked error are kept. Undefined for a status Agent Rishi doesn't know.
 */
export function codexMcpServerState(
  n: McpServerStatusUpdatedNotification,
): McpServerState | undefined {
  const name = typeof n.name === "string" ? n.name.trim().slice(0, 200) : "";
  const state = liveState(n);
  if (!name || !state) return undefined;
  const error =
    state === "failed" || state === "needs_sign_in" ? mcpServerError(n.error) : undefined;
  return { name, state, ...(error ? { error } : {}) };
}

function liveState(n: McpServerStatusUpdatedNotification): McpServerLiveState | undefined {
  switch (n.status) {
    case "starting":
      return "starting";
    case "ready":
      return "connected";
    case "failed":
      return n.failureReason === "reauthenticationRequired" ? "needs_sign_in" : "failed";
    case "cancelled":
      return "disabled";
    default:
      return undefined;
  }
}

/**
 * The session's MCP servers as Codex reports their startup, one server per notification:
 * reported as the whole list (`session.updated { mcpServers }`) whenever a server's state
 * changes, in the order Codex first named them.
 */
export class CodexMcpStatus {
  private readonly byName = new Map<string, McpServerState>();

  constructor(private readonly emit: (event: AgentEvent) => void) {}

  update(n: McpServerStatusUpdatedNotification): void {
    const next = codexMcpServerState(n);
    if (!next) return;
    const before = this.byName.get(next.name);
    if (before && sameMcpServers([before], [next])) return;
    this.byName.set(next.name, next);
    this.emit({ type: "session.updated", mcpServers: [...this.byName.values()] });
  }
}
