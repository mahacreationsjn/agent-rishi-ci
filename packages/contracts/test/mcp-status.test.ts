import { describe, expect, it } from "vitest";
import {
  AgentEvent,
  MCP_SERVER_ERROR_MAX,
  McpServerState,
  mcpServerError,
  mcpServerNeedsAttention,
  ProviderCapabilities,
  Session,
  sameMcpServers,
} from "../src";
import { sampleSession as session } from "./fixtures";

function roundTrip<T>(schema: { parse: (v: unknown) => T }, value: unknown): T {
  const first = schema.parse(value);
  const second = schema.parse(JSON.parse(JSON.stringify(first)));
  expect(second).toEqual(first);
  return second;
}

const capabilities = {
  resume: true,
  steer: false,
  interrupt: true,
  approvals: true,
  userQuestions: false,
  subagents: false,
  rollback: false,
  fork: false,
  images: false,
  planMode: false,
  reasoningEffort: false,
  mcp: true,
  skills: false,
};

const servers = [
  { name: "agent-rishi", state: "connected", origin: "config" },
  { name: "github", state: "needs_sign_in" },
  { name: "db", state: "failed", error: "spawn db-mcp ENOENT" },
  { name: "slow", state: "starting" },
  { name: "off", state: "disabled" },
  { name: "claude.ai Gmail", state: "needs_sign_in", origin: "account" },
  { name: "plugin:data:hex", state: "needs_sign_in", origin: "plugin" },
  { name: "plugin:sentry:sentry", state: "failed", origin: "plugin" },
  { name: "in-process", state: "connected", origin: "host" },
];

describe("MCP server live state contracts", () => {
  it("round-trips every state on session.updated and on the session", () => {
    const event = { type: "session.updated", mcpServers: servers };
    expect(roundTrip(AgentEvent, event)).toEqual(event);
    expect(roundTrip(Session, { ...session, mcpServers: servers }).mcpServers).toEqual(servers);
    expect(roundTrip(Session, { ...session, mcpServers: null }).mcpServers).toBeNull();
    expect(roundTrip(Session, session).mcpServers).toBeUndefined();
  });

  it("rejects unknown states and origins, empty names and over-long errors", () => {
    expect(McpServerState.safeParse({ name: "x", state: "needs-auth" }).success).toBe(false);
    expect(
      McpServerState.safeParse({ name: "x", state: "connected", origin: "claudeai" }).success,
    ).toBe(false);
    expect(McpServerState.safeParse({ name: "", state: "failed" }).success).toBe(false);
    const long = "e".repeat(MCP_SERVER_ERROR_MAX + 1);
    expect(McpServerState.safeParse({ name: "x", state: "failed", error: long }).success).toBe(
      false,
    );
  });

  it("keeps mcpStatus optional on capabilities (absent counts as false)", () => {
    expect(ProviderCapabilities.parse(capabilities).mcpStatus).toBeUndefined();
    expect(roundTrip(ProviderCapabilities, { ...capabilities, mcpStatus: true }).mcpStatus).toBe(
      true,
    );
  });

  it("keeps the first line of an error, secrets masked and clipped", () => {
    expect(mcpServerError("Connection refused\n  at connect (net.js:1)")).toBe(
      "Connection refused",
    );
    const leaked = mcpServerError(
      "401 from https://mcp.example.com with Authorization: Bearer sk-ant-abcdefghijklmnopqrstuvwxyz0123456789",
    );
    expect(leaked).not.toContain("sk-ant-abcdefghijklmnopqrstuvwxyz0123456789");
    const clipped = mcpServerError("x".repeat(1000));
    expect(clipped?.length).toBe(MCP_SERVER_ERROR_MAX);
    expect(McpServerState.parse({ name: "x", state: "failed", error: clipped }).error).toBe(
      clipped,
    );
    expect(mcpServerError("   ")).toBeUndefined();
    expect(mcpServerError(undefined)).toBeUndefined();
  });

  it("flags failed servers and config servers needing sign-in, and compares lists", () => {
    const parsed = servers.map((s) => McpServerState.parse(s));
    // An account connector or a plugin's server that only needs sign-in isn't this work's problem.
    expect(parsed.filter(mcpServerNeedsAttention).map((s) => s.name)).toEqual([
      "github",
      "db",
      "plugin:sentry:sentry",
    ]);
    expect(sameMcpServers(parsed, structuredClone(parsed))).toBe(true);
    expect(sameMcpServers(parsed, parsed.slice(1))).toBe(false);
    const changed = parsed.map((s, i) => (i === 0 ? { ...s, state: "failed" as const } : s));
    expect(sameMcpServers(parsed, changed)).toBe(false);
    const moved = parsed.map((s, i) => (i === 0 ? { ...s, origin: "plugin" as const } : s));
    expect(sameMcpServers(parsed, moved)).toBe(false);
    expect(sameMcpServers(null, undefined)).toBe(false);
    expect(sameMcpServers(null, null)).toBe(true);
  });
});
