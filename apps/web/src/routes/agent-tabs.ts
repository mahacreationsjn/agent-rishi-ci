import { providersWith } from "@agent-rishi/contracts";

/** The Agents page's tabs; apart from the page so the router can check `?tab=` without it. */
export type AgentTab = "memory" | "skills" | "subagents" | "mcp" | "hooks";

/** The tabs on offer; Hooks only when some provider's native config has hooks. */
export const AGENT_TABS: { id: AgentTab; label: string }[] = [
  { id: "memory", label: "Memory" },
  { id: "skills", label: "Skills" },
  { id: "subagents", label: "Subagents" },
  { id: "mcp", label: "MCP servers" },
  ...(providersWith("hooks").length > 0 ? [{ id: "hooks" as const, label: "Hooks" }] : []),
];
