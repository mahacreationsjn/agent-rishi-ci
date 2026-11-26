import { EventEmitter } from "node:events";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { PassThrough } from "node:stream";
import {
  AGENT_RISHI_MCP_CONFIG_DIR,
  type McpServerConfig,
  type SessionOptions,
} from "@agent-rishi/contracts";
import { query, type SpawnedProcess, type SpawnOptions } from "@anthropic-ai/claude-agent-sdk";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ProviderSession } from "../src/adapter";
import { buildQueryOptions } from "../src/claude/options";
import { ClaudeSession } from "../src/claude/session";
import { CodexSession } from "../src/codex/session";
import { CursorAdapter } from "../src/cursor/adapter";
import { GeminiAdapter } from "../src/gemini/adapter";
import { OpenCodeAdapter } from "../src/opencode/adapter";

/**
 * MCP bearer tokens never go on an agent CLI's command line (§15): any local process can read a
 * command line (`ps`, `/proc/<pid>/cmdline`, Task Manager), and on Linux and macOS so can other
 * OS users. Every provider's spawn arguments are checked with Agent Rishi's own MCP server in the
 * session, and the token is shown to reach the agent another way (stdin, a private file, the
 * environment), so the check can't pass by dropping the server.
 */

/** Every process the providers start through `spawnResolved`, by its final command line. */
const spawned = vi.hoisted(() => [] as string[][]);
vi.mock("../src/util/exec", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/util/exec")>();
  return {
    ...actual,
    spawnResolved: (...args: Parameters<typeof actual.spawnResolved>) => {
      const [file, argv] = actual.spawnArgs(args[0], args[1]);
      spawned.push([file, ...argv]);
      return actual.spawnResolved(...args);
    },
  };
});

const TOKEN = "cdm_secret_session_token";
const agentRishi: McpServerConfig = {
  transport: "http",
  name: "agent-rishi",
  url: "http://127.0.0.1:5000/mcp",
  headers: { Authorization: `Bearer ${TOKEN}` },
  toolTimeoutSec: 600,
  trusted: true,
};

const fixture = (...parts: string[]) => ({
  kind: "node-script" as const,
  path: process.execPath,
  script: join(import.meta.dirname, "fixtures", ...parts),
});

let dir: string;
const sessions: ProviderSession[] = [];
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "agent-rishi-argv-"));
  spawned.length = 0;
});
afterEach(async () => {
  await Promise.all(sessions.splice(0).map((s) => s.close()));
  for (const name of ["FAKE_CODEX_LOG", "FAKE_OPENCODE_LOG", "FAKE_OPENCODE_STATE"]) {
    delete process.env[name];
  }
  rmSync(dir, { recursive: true, force: true });
});

function options(extra: Partial<SessionOptions> = {}): SessionOptions {
  return {
    sessionId: "s1",
    role: "agent",
    cwd: dir,
    autonomy: "auto",
    mcpServers: [agentRishi],
    additionalDirectories: [],
    planMode: false,
    agentRishiHome: join(dir, "home"),
    ...extra,
  };
}

/** No command line carries the token or its header. */
function expectNoTokenIn(commandLines: string[][]): void {
  expect(commandLines.length).toBeGreaterThan(0);
  for (const line of commandLines) {
    const text = line.join(" ");
    expect(text).not.toContain("cdm_");
    expect(text).not.toContain("Bearer");
  }
}

/** A process that exits as soon as it is spawned: the SDK's own command line is what we keep. */
function exitingProcess(): SpawnedProcess {
  const proc = new EventEmitter() as EventEmitter & { exitCode: number | null };
  const stdout = new PassThrough();
  Object.assign(proc, { stdin: new PassThrough(), stdout, killed: false, exitCode: null });
  Object.assign(proc, { kill: () => true });
  setImmediate(() => {
    proc.exitCode = 1;
    stdout.end();
    proc.emit("exit", 1, null);
  });
  return proc as unknown as SpawnedProcess;
}

/**
 * A Claude session on the real Claude Agent SDK, whose `claude` command line is caught before
 * anything starts (`spawnClaudeCodeProcess`): no process, no model.
 */
async function claudeSession(
  opts: SessionOptions,
): Promise<{ session: ClaudeSession; spawn: SpawnOptions }> {
  let spawn: SpawnOptions | undefined;
  const session = new ClaudeSession(opts, {
    executable: { kind: "native", path: process.execPath },
    notesRoots: [],
    query: (params) =>
      query({
        ...params,
        options: {
          ...params.options,
          spawnClaudeCodeProcess: (o) => {
            spawn = o;
            return exitingProcess();
          },
        },
      }),
  });
  sessions.push(session);
  const deadline = Date.now() + 10_000;
  while (!spawn) {
    if (Date.now() > deadline) throw new Error("the SDK never spawned Claude");
    await new Promise((r) => setTimeout(r, 10));
  }
  return { session, spawn };
}

/** The value after `flag` on a command line. */
const flagValue = (args: string[], flag: string) => args[args.indexOf(flag) + 1];

describe("MCP tokens stay off provider command lines", () => {
  it("Claude: the token goes in a private config file, not on the command line", async () => {
    const { spawn } = await claudeSession(options());
    expectNoTokenIn([[spawn.command, ...spawn.args]]);
    const file = flagValue(spawn.args, "--mcp-config") as string;
    expect(JSON.parse(readFileSync(file, "utf8"))).toEqual({
      mcpServers: {
        "agent-rishi": { type: "http", url: agentRishi.url, headers: agentRishi.headers },
      },
    });
  });

  it("Claude: the file is owner-only in its session's folder in Agent Rishi's home, and removed on close", async () => {
    const home = join(dir, "home");
    const { session, spawn } = await claudeSession(options({ agentRishiHome: home }));
    const file = flagValue(spawn.args, "--mcp-config") as string;
    const folder = dirname(file);
    expect(dirname(folder)).toBe(join(home, AGENT_RISHI_MCP_CONFIG_DIR));
    expect(basename(folder)).toMatch(/^session-s1-\w{6}$/);
    if (process.platform !== "win32") {
      expect(statSync(file).mode & 0o777).toBe(0o600);
      expect(statSync(folder).mode & 0o777).toBe(0o700);
    }
    await session.close();
    expect(existsSync(file)).toBe(false);
    expect(existsSync(folder)).toBe(false);
  });

  it("Claude: without Agent Rishi's home, the file goes to a private temp folder, removed on close", async () => {
    const { session, spawn } = await claudeSession(options({ agentRishiHome: undefined }));
    const file = flagValue(spawn.args, "--mcp-config") as string;
    expect(dirname(dirname(file))).toBe(tmpdir());
    if (process.platform !== "win32") expect(statSync(file).mode & 0o777).toBe(0o600);
    await session.close();
    expect(existsSync(dirname(file))).toBe(false);
  });

  it("Claude: a session without MCP servers writes no file", async () => {
    const { spawn } = await claudeSession(options({ mcpServers: [] }));
    expect(spawn.args).not.toContain("--mcp-config");
  });

  it("Claude: the query options never take MCP servers inline", () => {
    const build = (mcpConfigFile?: string) =>
      buildQueryOptions({
        session: options(),
        executable: { kind: "native", path: "/bin/claude" },
        canUseTool: async () => ({ behavior: "allow", updatedInput: {} }),
        hooks: {},
        abortController: new AbortController(),
        ...(mcpConfigFile ? { mcpConfigFile } : {}),
      });
    expect(() => build()).toThrow(/private config file/);
    const opts = build("/private/mcp.json");
    expect(opts.mcpServers).toBeUndefined();
    expect(opts.extraArgs).toEqual({ "mcp-config": "/private/mcp.json" });
  });

  it("Codex: the token goes over stdin (thread/start config)", async () => {
    const log = join(dir, "codex.log");
    process.env.FAKE_CODEX_LOG = log;
    const session = new CodexSession(options(), {
      executable: fixture("fake-codex", "app-server.mjs"),
    });
    sessions.push(session);
    await session.start();
    expectNoTokenIn(spawned);
    expect(readFileSync(log, "utf8")).toContain(TOKEN);
  });

  it("OpenCode: the token goes in the server's environment", async () => {
    const log = join(dir, "opencode.log");
    process.env.FAKE_OPENCODE_LOG = log;
    process.env.FAKE_OPENCODE_STATE = join(dir, "state.json");
    const adapter = new OpenCodeAdapter({
      executable: fixture("fake-opencode", "opencode.mjs"),
      noGuardPlugin: true,
    });
    sessions.push(await adapter.openSession(options()));
    expectNoTokenIn(spawned);
    expect(readFileSync(log, "utf8")).toContain(TOKEN);
  });

  it("Cursor (ACP): the token goes over stdin (session/new)", async () => {
    const log = join(dir, "acp.log");
    const script = join(dir, "script.json");
    writeFileSync(script, "[]");
    const adapter = new CursorAdapter({ executable: fixture("fake-acp", "agent.mjs") });
    sessions.push(
      await adapter.openSession(options({ env: { FAKE_ACP_LOG: log, FAKE_ACP_SCRIPT: script } })),
    );
    expectNoTokenIn(spawned);
    expect(readFileSync(log, "utf8")).toContain(TOKEN);
  });

  it("Gemini (ACP): the token goes over stdin (session/new)", async () => {
    const log = join(dir, "gemini.log");
    const script = join(dir, "script.json");
    writeFileSync(script, "[]");
    const adapter = new GeminiAdapter({ executable: fixture("fake-gemini", "gemini.mjs") });
    sessions.push(
      await adapter.openSession(
        options({ env: { FAKE_GEMINI_LOG: log, FAKE_GEMINI_SCRIPT: script } }),
      ),
    );
    expectNoTokenIn(spawned);
    expect(readFileSync(log, "utf8")).toContain(TOKEN);
  });
});
