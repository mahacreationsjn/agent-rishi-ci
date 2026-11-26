import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentEvent, SessionOptions } from "@agent-rishi/contracts";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ProviderSession } from "../src/adapter";
import { OpenCodeAdapter } from "../src/opencode/adapter";
import { readProjectConfig } from "../src/opencode/project-config";
import { openCodeServerEnv } from "../src/opencode/server";

// #643: a project's own OpenCode config that git doesn't track reaches the model list and the
// sessions. Everything runs against the scripted fake `opencode` and temp folders; nothing
// reads the user's real OpenCode config.

const fakeOpenCode = {
  kind: "node-script" as const,
  path: process.execPath,
  script: join(import.meta.dirname, "fixtures", "fake-opencode", "opencode.mjs"),
};

/** A project config with a custom provider OpenCode's global config doesn't have. */
const NINE_ROUTER = {
  provider: {
    "9router": {
      name: "9Router",
      options: { baseURL: "http://127.0.0.1:9/v1", apiKey: "{env:NINE_ROUTER_TEST_KEY}" },
      models: { Worker: { name: "Worker" } },
    },
  },
};

let root: string;
let project: string;
let worktree: string;
const sessions: ProviderSession[] = [];

type Start = { kind: string; config?: Record<string, unknown>; cwd?: string };
const starts = (): Start[] => {
  const file = join(root, "requests.log");
  if (!existsSync(file)) return [];
  return readFileSync(file, "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as Start)
    .filter((entry) => entry.kind === "start");
};
const requests = (path: RegExp) =>
  existsSync(join(root, "requests.log"))
    ? readFileSync(join(root, "requests.log"), "utf8")
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line) as { kind: string; path?: string; body?: unknown })
        .filter((r) => r.kind === "request" && path.test(r.path ?? ""))
    : [];

function write(dir: string, rel: string, value: unknown): void {
  const file = join(dir, rel);
  mkdirSync(join(file, ".."), { recursive: true });
  writeFileSync(file, typeof value === "string" ? value : JSON.stringify(value));
}

/** The fake's lists are complete at once: settle them in milliseconds, not the product's ~1.6 s. */
const catalog = { pollMs: 10, settlePolls: 2 };
const adapter = () =>
  new OpenCodeAdapter({ executable: fakeOpenCode, noGuardPlugin: true, catalog });

function options(extra: Partial<SessionOptions> = {}): SessionOptions {
  return {
    sessionId: "s1",
    role: "agent",
    cwd: worktree,
    projectDir: project,
    autonomy: "auto",
    mcpServers: [],
    additionalDirectories: [],
    planMode: false,
    ...extra,
  };
}

async function open(extra: Partial<SessionOptions> = {}) {
  const session = await adapter().openSession(options(extra));
  sessions.push(session);
  return session;
}

/** Events until the root turn ends. */
async function turn(session: ProviderSession, text: string): Promise<AgentEvent[]> {
  const it = session.events[Symbol.asyncIterator]();
  await session.send({ text, attachments: [] });
  const events: AgentEvent[] = [];
  const deadline = Date.now() + 8000;
  for (;;) {
    const next = await Promise.race([
      it.next(),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error("timed out")), deadline - Date.now()),
      ),
    ]);
    if (next.done) return events;
    events.push(next.value);
    const e = next.value;
    if (
      (e.type === "turn.completed" || e.type === "turn.failed") &&
      e.threadId.endsWith(":thread-root")
    )
      return events;
  }
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "agent-rishi-oc-project-"));
  project = join(root, "project");
  worktree = join(root, "worktree");
  mkdirSync(project);
  mkdirSync(worktree);
  process.env.FAKE_OPENCODE_LOG = join(root, "requests.log");
  process.env.FAKE_OPENCODE_STATE = join(root, "state.json");
});

afterEach(async () => {
  await Promise.all(sessions.splice(0).map((s) => s.close()));
  delete process.env.FAKE_OPENCODE_LOG;
  delete process.env.FAKE_OPENCODE_STATE;
  rmSync(root, { recursive: true, force: true });
});

describe("reading a project's OpenCode config", () => {
  it("merges the files in OpenCode's order and leaves out plugins and permission rules", () => {
    write(project, "opencode.jsonc", '{ // comment\n "model": "a/one", "share": "manual", }');
    write(project, "opencode.json", { model: "a/two", plugins: ["./evil.js"] });
    write(project, ".opencode/opencode.json", { ...NINE_ROUTER, permission: { edit: "allow" } });
    const read = readProjectConfig(project);
    expect(read.files).toEqual(["opencode.jsonc", "opencode.json", ".opencode/opencode.json"]);
    expect(read.config).toEqual({ model: "a/two", share: "manual", ...NINE_ROUTER });
    expect(read.warnings).toEqual([]);
    expect(read.fingerprint).toMatch(/^[0-9a-f]{64}$/);
    expect(readProjectConfig(join(root, "missing"))).toMatchObject({ config: undefined });
  });

  it("skips a file that isn't valid JSON with a warning that never quotes it", () => {
    write(project, "opencode.json", '{ "provider": { "x": { "apiKey": "sk-secret-123" ');
    write(project, ".opencode/opencode.json", NINE_ROUTER);
    const read = readProjectConfig(project);
    expect(read.config).toEqual(NINE_ROUTER);
    expect(read.warnings).toEqual([
      "Left out the project's OpenCode config opencode.json: it isn't valid JSON.",
    ]);
    expect(read.warnings.join(" ")).not.toContain("sk-secret");
  });

  it("leaves out a file the session's folder already has (git tracks it there)", () => {
    write(project, "opencode.json", NINE_ROUTER);
    write(project, ".opencode/opencode.json", { model: "9router/Worker" });
    write(worktree, "opencode.json", { model: "tracked/copy" });
    const read = readProjectConfig(project, { skipIn: worktree });
    expect(read.files).toEqual([".opencode/opencode.json"]);
    expect(read.config).toEqual({ model: "9router/Worker" });
    // A session in the project folder itself reads everything natively.
    expect(readProjectConfig(project, { skipIn: project }).config).toBeUndefined();
  });

  it("layers it under the user's inline config and Agent Rishi's, which win", () => {
    const env = openCodeServerEnv(
      {
        PATH: "/bin",
        NINE_ROUTER_TEST_KEY: "key-1",
        AGENT_RISHI_HOME: "/home/agent-rishi",
        OPENCODE_CONFIG_CONTENT: JSON.stringify({ model: "user/inline" }),
      },
      undefined,
      "pw",
      { plugins: ["guard"], mcp: { servers: { "agent-rishi": { type: "remote", url: "u" } } } },
      {
        ...NINE_ROUTER,
        model: "9router/Worker",
        small_model: "{env:AGENT_RISHI_HOME}",
        mcp: {
          servers: {
            "agent-rishi": { type: "local", command: ["x"], enabled: false },
            docs: { type: "remote", url: "d" },
          },
          // OpenCode's V1 form, which it still reads beside `servers`.
          "agent-rishi": { enabled: false, headers: { Authorization: "x" } },
          legacy: { type: "local", command: ["y"] },
        },
      },
    );
    const config = JSON.parse(env.OPENCODE_CONFIG_CONTENT ?? "") as Record<string, unknown>;
    expect(config).toMatchObject({ model: "user/inline", plugins: ["guard"] });
    expect(config.provider).toEqual({
      "9router": {
        ...NINE_ROUTER.provider["9router"],
        options: { baseURL: "http://127.0.0.1:9/v1", apiKey: "key-1" },
      },
    });
    // Agent Rishi's own MCP server is its entry alone, in either form; the project's others stay.
    expect(config.mcp).toEqual({
      servers: { "agent-rishi": { type: "remote", url: "u" }, docs: { type: "remote", url: "d" } },
      legacy: { type: "local", command: ["y"] },
    });
    // Agent Rishi's internal variables never reach the config.
    expect(config.small_model).toBe("");
  });
});

describe("OpenCode model list per project", () => {
  it("lists the project's own provider for that project only, kept until it changes", async () => {
    write(project, "opencode.json", NINE_ROUTER);
    const a = adapter();
    await a.refreshModels();
    const list = await a.projectModels(project);
    expect(list.warnings).toEqual([]);
    expect(list.models.map((m) => m.id)).toContain("9router/Worker");
    expect(list.models.find((m) => m.id === "9router/Worker")?.description).toBe("9Router");
    // The global list doesn't have it, and a project without config gets the global list.
    expect(a.models().map((m) => m.id)).not.toContain("9router/Worker");
    const other = join(root, "other");
    mkdirSync(other);
    expect((await a.projectModels(other)).models).toEqual(a.models());
    // Kept per project: asking again starts no server; a refresh or a config change does.
    const before = starts().length;
    await a.projectModels(project);
    expect(starts().length).toBe(before);
    await a.projectModels(project, { refresh: true });
    expect(starts().length).toBe(before + 1);
    write(project, "opencode.json", {
      provider: { "9router": { models: { Planner: { name: "Planner" } } } },
    });
    const changed = await a.projectModels(project);
    expect(changed.models.map((m) => m.id)).toContain("9router/Planner");
    expect(starts().length).toBe(before + 2);
    // A new global list (a sign-in, a new provider) makes every project list again.
    await a.refreshModels();
    await a.projectModels(project);
    expect(starts().length).toBe(before + 4);
  });

  it("falls back to the global list with a warning when the config isn't valid JSON", async () => {
    write(project, "opencode.json", "{ not json");
    const a = adapter();
    await a.refreshModels();
    const list = await a.projectModels(project);
    expect(list.models).toEqual(a.models());
    expect(list.warnings).toEqual([
      "Left out the project's OpenCode config opencode.json: it isn't valid JSON.",
    ]);
  });
});

describe("OpenCode sessions with a project's config", () => {
  it("give the worktree the project's untracked provider; Agent Rishi's rules still win", async () => {
    write(project, "opencode.json", {
      ...NINE_ROUTER,
      permission: { edit: "allow", bash: "allow" },
      plugins: ["./project-plugin.js"],
    });
    const session = await open({
      model: "9router/Worker",
      mcpServers: [{ transport: "http", name: "agent-rishi", url: "http://127.0.0.1:1/mcp" }],
    });
    const events = await turn(session, "hello");
    expect(events.at(-1)).toMatchObject({ type: "turn.completed" });
    const start = starts()[0];
    expect(start?.cwd).toBe(worktree);
    expect(start?.config).toMatchObject({ provider: { "9router": { name: "9Router" } } });
    expect(start?.config?.permission).toBeUndefined();
    expect(start?.config?.plugins).toBeUndefined();
    expect(start?.config?.mcp).toMatchObject({ servers: { "agent-rishi": { type: "remote" } } });
    const create = requests(/^\/api\/session$/)[0]?.body as Record<string, unknown>;
    expect(create.model).toMatchObject({ providerID: "9router", id: "Worker" });
    expect(create.permissions).toEqual(
      expect.arrayContaining([
        { action: "edit", resource: "*", effect: "ask" },
        { action: "shell", resource: "*", effect: "ask" },
      ]),
    );
  });

  it("don't add a config the worktree already tracks", async () => {
    write(project, "opencode.json", NINE_ROUTER);
    write(worktree, "opencode.json", { model: "anthropic/claude-opus-5-5" });
    await open();
    expect(starts()[0]?.config?.provider).toBeUndefined();
  });

  it("skip a project config that isn't valid JSON and say so in the first turn", async () => {
    write(project, "opencode.json", "{ broken");
    const session = await open();
    const events = await turn(session, "hello");
    expect(events.at(-1)).toMatchObject({ type: "turn.completed" });
    const notice = events.find((e) => e.type === "item.completed" && e.item.kind === "notice") as
      | Extract<AgentEvent, { type: "item.completed" }>
      | undefined;
    expect(notice?.item).toMatchObject({
      level: "warning",
      code: "project_config_skipped",
      message: "Left out the project's OpenCode config opencode.json: it isn't valid JSON.",
    });
    expect(starts()[0]?.config?.provider).toBeUndefined();
  });
});
