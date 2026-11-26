import { AgentEvent, MCP_SERVER_ERROR_MAX } from "@agent-rishi/contracts";
import { describe, expect, it, vi } from "vitest";
import { ClaudeEventMapper } from "../src/claude/mapper";
import { McpStatusRefresher } from "../src/claude/mcp-refresh";
import { toMcpServerStates } from "../src/claude/mcp-status";
import { CodexEventMapper } from "../src/codex/mapper";
import type { ServerNotification } from "../src/codex/protocol";

const mcpUpdates = (events: AgentEvent[]) =>
  events.flatMap((e) => (e.type === "session.updated" && e.mcpServers ? [e.mcpServers] : []));

describe("Claude MCP server states", () => {
  function setup() {
    const events: AgentEvent[] = [];
    const mapper = new ClaudeEventMapper({
      sessionId: "s1",
      cwd: "/work",
      emit: (e) => events.push(AgentEvent.parse(e)),
    });
    return { mapper, events };
  }

  // `system/init` as the Agent SDK sends it: name, status and source, no errors.
  const init = (mcp_servers: unknown) => ({
    type: "system",
    subtype: "init",
    session_id: "claude-1",
    model: "claude-opus-5-5",
    cwd: "/work",
    tools: [],
    mcp_servers,
    apiKeySource: "none",
    claude_code_version: "2.9.0",
    permissionMode: "default",
    slash_commands: [],
  });

  it("maps every status from system/init", () => {
    const { mapper, events } = setup();
    mapper.handle(
      init([
        { name: "agent-rishi", status: "connected", source: "dynamic" },
        { name: "db", status: "failed", source: "project" },
        { name: "github", status: "needs-auth", source: "claudeai" },
        { name: "slow", status: "pending", source: "user" },
        { name: "off", status: "disabled", source: "local" },
      ]),
    );
    expect(mcpUpdates(events)).toEqual([
      [
        { name: "agent-rishi", state: "connected", origin: "config" },
        { name: "db", state: "failed", origin: "config" },
        { name: "github", state: "needs_sign_in", origin: "account" },
        { name: "slow", state: "starting", origin: "config" },
        { name: "off", state: "disabled", origin: "config" },
      ],
    ]);
  });

  it("reports again only when a later init or a status refresh differs", () => {
    const { mapper, events } = setup();
    mapper.handle(init([{ name: "db", status: "pending" }]));
    mapper.handle(init([{ name: "db", status: "pending" }]));
    expect(mcpUpdates(events)).toHaveLength(1);

    // `mcpServerStatus()`: carries the error, and the server's config, which is never kept.
    mapper.reportMcpServers([
      {
        name: "db",
        status: "failed",
        error: "spawn db-mcp ENOENT\n    at ChildProcess._handle.onexit",
        config: { type: "stdio", command: "db-mcp", env: { DB_PASSWORD: "hunter2-hunter2" } },
        scope: "project",
      },
    ]);
    // A later init knows no error: the one from the refresh stays.
    mapper.handle(init([{ name: "db", status: "failed" }]));
    expect(mcpUpdates(events)).toEqual([
      [{ name: "db", state: "starting" }],
      [{ name: "db", state: "failed", origin: "config", error: "spawn db-mcp ENOENT" }],
    ]);
    expect(JSON.stringify(events)).not.toContain("hunter2");

    mapper.reportMcpServers([{ name: "db", status: "connected" }]);
    expect(mcpUpdates(events).at(-1)).toEqual([
      { name: "db", state: "connected", origin: "config" },
    ]);
  });

  // #528: Claude reports every claude.ai connector and plugin server the user never signed into
  // as `needs-auth`; `source` is what tells them apart from the project's own servers.
  it("keeps where each server comes from", () => {
    const states = toMcpServerStates([
      { name: "agent-rishi", status: "connected", source: "dynamic" },
      { name: "db", status: "failed", source: "project" },
      { name: "claude.ai Gmail", status: "needs-auth", source: "claudeai" },
      { name: "plugin:data:hex", status: "needs-auth", source: "plugin" },
      { name: "policy", status: "connected", source: "managed" },
      { name: "in-process", status: "connected", source: "sdk" },
      // An older CLI: only `scope`, or nothing at all.
      { name: "claude.ai Drive", status: "needs-auth", scope: "claudeai" },
      { name: "old-cli", status: "connected" },
      { name: "odd", status: "connected", source: "somewhere-new", scope: "toString" },
    ]);
    expect(states.map((s) => [s.name, s.origin])).toEqual([
      ["agent-rishi", "config"],
      ["db", "config"],
      ["claude.ai Gmail", "account"],
      ["plugin:data:hex", "plugin"],
      ["policy", "config"],
      ["in-process", "host"],
      ["claude.ai Drive", "account"],
      ["old-cli", undefined],
      ["odd", undefined],
    ]);

    // A later report that doesn't say keeps the origin already known.
    const later = toMcpServerStates([{ name: "claude.ai Gmail", status: "needs-auth" }], states);
    expect(later).toEqual([{ name: "claude.ai Gmail", state: "needs_sign_in", origin: "account" }]);
  });

  it("masks secrets in errors, clips them, and skips unknown or nameless entries", () => {
    const states = toMcpServerStates([
      {
        name: "api",
        status: "failed",
        error: `HTTP 401 with Authorization: Bearer abcdefghijklmnopqrstuvwxyz0123456789ABCD ${"x".repeat(500)}`,
      },
      { name: "", status: "connected" },
      { name: "weird", status: "exploded" },
      { name: "api", status: "connected" },
      "not a server",
    ]);
    expect(states).toHaveLength(1);
    expect(states[0]?.error).not.toContain("abcdefghijklmnopqrstuvwxyz0123456789ABCD");
    expect(states[0]?.error?.length).toBe(MCP_SERVER_ERROR_MAX);
    expect(toMcpServerStates(undefined)).toEqual([]);
  });

  it("refreshes while a server starts, and never throws for a CLI that can't answer", async () => {
    vi.useFakeTimers();
    try {
      const { mapper, events } = setup();
      const answers = [
        [{ name: "slow", status: "pending" }],
        [{ name: "slow", status: "pending" }],
        [{ name: "slow", status: "connected" }],
      ];
      let reads = 0;
      const refresher = new McpStatusRefresher({
        read: async () => answers[reads++],
        report: (list) => mapper.reportMcpServers(list),
        delaysMs: [1_000, 1_000, 1_000],
      });
      refresher.refresh();
      await vi.advanceTimersByTimeAsync(0);
      expect(reads).toBe(1);
      await vi.advanceTimersByTimeAsync(2_000);
      expect(reads).toBe(3);
      expect(mcpUpdates(events)).toEqual([
        [{ name: "slow", state: "starting" }],
        [{ name: "slow", state: "connected" }],
      ]);
      // Connected: no more reads until the next refresh.
      await vi.advanceTimersByTimeAsync(10_000);
      expect(reads).toBe(3);

      const broken = new McpStatusRefresher({
        read: () => {
          throw new TypeError("mcpServerStatus is not a function");
        },
        report: (list) => mapper.reportMcpServers(list),
      });
      broken.refresh();
      await vi.advanceTimersByTimeAsync(0);
      broken.stop();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("Codex MCP server states", () => {
  const T = "thread-x";

  function setup() {
    const events: AgentEvent[] = [];
    const mapper = new CodexEventMapper("s1", (e) => events.push(AgentEvent.parse(e)));
    mapper.codexThreadId = T;
    const status = (params: object) =>
      mapper.handle({
        method: "mcpServer/startupStatus/updated",
        params: { threadId: T, error: null, failureReason: null, ...params },
      } as unknown as ServerNotification);
    return { events, status };
  }

  it("maps each startup status for the session's thread", () => {
    const { events, status } = setup();
    status({ name: "agent-rishi", status: "starting" });
    status({ name: "agent-rishi", status: "ready" });
    status({ name: "db", status: "failed", error: "No such file or directory (os error 2)" });
    status({
      name: "linear",
      status: "failed",
      error: "OAuth token expired",
      failureReason: "reauthenticationRequired",
    });
    status({ name: "slow", status: "cancelled" });
    expect(mcpUpdates(events)).toEqual([
      [{ name: "agent-rishi", state: "starting" }],
      [{ name: "agent-rishi", state: "connected" }],
      [
        { name: "agent-rishi", state: "connected" },
        { name: "db", state: "failed", error: "No such file or directory (os error 2)" },
      ],
      [
        { name: "agent-rishi", state: "connected" },
        { name: "db", state: "failed", error: "No such file or directory (os error 2)" },
        { name: "linear", state: "needs_sign_in", error: "OAuth token expired" },
      ],
      [
        { name: "agent-rishi", state: "connected" },
        { name: "db", state: "failed", error: "No such file or directory (os error 2)" },
        { name: "linear", state: "needs_sign_in", error: "OAuth token expired" },
        { name: "slow", state: "disabled" },
      ],
    ]);
  });

  it("ignores other threads, repeats and unknown statuses", () => {
    const { events, status } = setup();
    status({ name: "agent-rishi", status: "ready" });
    // A sub-agent's thread starts its own servers.
    status({ threadId: "sub-agent-thread", name: "db", status: "failed", error: "boom" });
    status({ name: "agent-rishi", status: "ready" });
    status({ name: "agent-rishi", status: "rebooting" });
    expect(mcpUpdates(events)).toEqual([[{ name: "agent-rishi", state: "connected" }]]);
    // The app-server as a whole (no thread) is the session's own process.
    status({ threadId: null, name: "db", status: "starting" });
    expect(mcpUpdates(events).at(-1)).toEqual([
      { name: "agent-rishi", state: "connected" },
      { name: "db", state: "starting" },
    ]);
  });
});
