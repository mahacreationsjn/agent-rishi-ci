import { agentEnv } from "@agent-rishi/providers";

/**
 * Environment for child processes (§15): terminals, setup scripts, git and MCP server tests.
 * The user's environment without Agent Rishi's own `AGENT_RISHI_*` variables, as agents get it
 * (`agentEnv`), plus `extra`.
 */
export function childEnv(extra: Record<string, string> = {}): Record<string, string> {
  return agentEnv(extra);
}
