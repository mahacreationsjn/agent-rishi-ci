/**
 * Agent Rishi's own variables: `AGENT_RISHI_HOME`, `AGENT_RISHI_DEPS_INSTALLER`, `AGENT_RISHI_DEBUG` and the
 * rest configure Agent Rishi's server and runner, never the user's work. Matched in any case:
 * Windows environment names are case-insensitive.
 */
const AGENT_RISHI_VAR = /^AGENT_RISHI_/i;

/**
 * Set when the desktop app runs Agent Rishi's own processes on its Electron binary (§17). It must
 * not reach the user's agents and shells: an Electron app started there would run as Node.js.
 */
const RUNTIME_ONLY = new Set(["ELECTRON_RUN_AS_NODE"]);

/**
 * Environment for the processes Agent Rishi starts for the user's work (§15): agents of every
 * provider, terminals and setup scripts. It is `base` (the runner's environment) without
 * Agent Rishi's own variables, so an Agent Rishi checkout's tests run in a session never pick up the
 * installer or data folder of the Agent Rishi running them, then `extra` on top. `extra` holds the
 * variables Agent Rishi means a process to see (`SessionOptions.env`), so it is kept as given.
 */
export function agentEnv(
  extra: Record<string, string> = {},
  base: NodeJS.ProcessEnv = process.env,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(base)) {
    if (value === undefined || AGENT_RISHI_VAR.test(key) || RUNTIME_ONLY.has(key.toUpperCase())) {
      continue;
    }
    out[key] = value;
  }
  return { ...out, ...extra };
}
