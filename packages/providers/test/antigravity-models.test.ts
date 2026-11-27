import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AntigravityAdapter } from "../src/antigravity/adapter";

/** Antigravity CLI lists the account's models only in a session: `refreshModels` opens one. */

const fakeAgy = {
  kind: "node-script" as const,
  path: process.execPath,
  script: join(import.meta.dirname, "fixtures", "fake-agy", "agy.mjs"),
};

type Logged = { method: string; params: Record<string, unknown> };
let dir: string;
let home: string;
const logFile = () => join(dir, "acp.log");
const logged = (method: string): Logged[] =>
  existsSync(logFile())
    ? readFileSync(logFile(), "utf8")
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line) as Logged)
        .filter((m) => m.method === method)
    : [];

const saved = { log: process.env.FAKE_AGY_LOG, auth: process.env.FAKE_AGY_AUTH };

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "agent-rishi-agy-models-"));
  home = mkdtempSync(join(tmpdir(), "agent-rishi-agy-models-home-"));
  // The listing runs with the runner's environment, as sessions do.
  process.env.FAKE_AGY_LOG = logFile();
  delete process.env.FAKE_AGY_AUTH;
});

afterEach(() => {
  for (const [key, value] of [
    ["FAKE_AGY_LOG", saved.log],
    ["FAKE_AGY_AUTH", saved.auth],
  ] as const) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

describe("Antigravity CLI model list", () => {
  it("lists the account's models before any session, without a prompt", async () => {
    const adapter = new AntigravityAdapter({ executable: fakeAgy, home });
    expect(adapter.models().map((m) => m.id)).toEqual(["default"]);
    let changes = 0;
    adapter.onModelsChanged(() => changes++);

    await adapter.refreshModels();

    expect(adapter.models().map((m) => m.id)).toEqual([
      "default",
      "gemini-4-hydrogen",
      "gemini-3.8-flash",
      "claude-sonnet-4-6",
    ]);
    expect(adapter.models()[1]?.efforts).toEqual(["low", "medium", "high", "xhigh"]);
    expect(changes).toBe(1);
    // Agent Rishi's strict settings, no MCP servers, no login, no prompt; closed at once.
    expect(logged("argv")[0]?.params.args).toEqual([
      "acp",
      "--process-per-session",
      "--disable-telemetry",
      "--cli_dir_name",
      "agent-rishi",
    ]);
    expect(logged("session/new")).toHaveLength(1);
    expect(logged("session/new")[0]?.params.mcpServers).toEqual([]);
    expect(logged("authenticate")).toEqual([]);
    expect(logged("session/prompt")).toEqual([]);
    expect(logged("session/close")).toEqual([
      { method: "session/close", params: { sessionId: "agy-1" } },
    ]);
  });

  it("skips a recent list from the same CLI, and shares one listing between callers", async () => {
    const adapter = new AntigravityAdapter({ executable: fakeAgy, home });
    await Promise.all([adapter.refreshModels(), adapter.refreshModels()]);
    expect(logged("session/new")).toHaveLength(1);

    await adapter.refreshModels({ maxAgeMs: 60_000 });
    expect(logged("session/new")).toHaveLength(1);

    // Without an age limit (the picker's refresh), the CLI is asked again.
    await adapter.refreshModels();
    expect(logged("session/new")).toHaveLength(2);
  });

  it("keeps Default when the CLI is signed out, and never throws", async () => {
    process.env.FAKE_AGY_AUTH = "missing";
    const adapter = new AntigravityAdapter({ executable: fakeAgy, home });
    await expect(adapter.refreshModels()).resolves.toBeUndefined();
    expect(adapter.models().map((m) => m.id)).toEqual(["default"]);
    expect(logged("authenticate")).toEqual([]);
  });
});
