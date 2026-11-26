import { describe, expect, it } from "vitest";
import { trustedMcpTools } from "../src/claude/options";
import { mcpOverride } from "../src/codex/config";

const agentRishi = {
  transport: "http" as const,
  name: "agent-rishi",
  url: "http://127.0.0.1:5000/mcp",
  headers: { Authorization: "Bearer cdm_x" },
  toolTimeoutSec: 600,
  trusted: true,
};

describe("MCP server injection", () => {
  it("maps Agent Rishi's server to a Codex override with timeout and no approval prompts", () => {
    expect(mcpOverride(agentRishi)).toEqual({
      "mcp_servers.agent-rishi": {
        url: agentRishi.url,
        http_headers: agentRishi.headers,
        tool_timeout_sec: 600,
        default_tools_approval_mode: "approve",
      },
    });
    expect(mcpOverride({ ...agentRishi, trusted: undefined, toolTimeoutSec: undefined })).toEqual({
      "mcp_servers.agent-rishi": { url: agentRishi.url, http_headers: agentRishi.headers },
    });
  });

  it("allows every tool of trusted servers in Claude", () => {
    expect(trustedMcpTools([agentRishi])).toEqual({ allowedTools: ["mcp__agent-rishi"] });
    expect(trustedMcpTools([{ ...agentRishi, trusted: false }])).toEqual({});
  });
});
