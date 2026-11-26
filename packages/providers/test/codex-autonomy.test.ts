import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentEvent, SessionOptions } from "@agent-rishi/contracts";
import { afterEach, describe, expect, it } from "vitest";
import { CodexSession } from "../src/codex/session";
import { FakeProvider } from "../src/fake/adapter";
import type { FakeSession } from "../src/fake/session";
import { osTempRoots } from "../src/policy/paths";

const base: SessionOptions = {
  sessionId: "s1",
  role: "agent",
  cwd: tmpdir(),
  autonomy: "auto",
  mcpServers: [],
  additionalDirectories: [],
  planMode: false,
};

const fakeCodex = {
  kind: "node-script" as const,
  path: process.execPath,
  script: join(import.meta.dirname, "fixtures", "fake-codex", "app-server.mjs"),
};

type Logged = { method: string; params: Record<string, unknown> };
const requests = (file: string): Logged[] =>
  existsSync(file)
    ? readFileSync(file, "utf8")
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line))
    : [];

const sessions: CodexSession[] = [];
afterEach(async () => {
  await Promise.all(sessions.splice(0).map((s) => s.close()));
  delete process.env.FAKE_CODEX_LOG;
  delete process.env.FAKE_CODEX_SANDBOX;
  delete process.env.FAKE_CODEX_REQUESTS;
});

describe("Codex autonomy changes", () => {
  it("carries the current approval and sandbox policy on every turn/start", async () => {
    const log = join(mkdtempSync(join(tmpdir(), "agent-rishi-codex-autonomy-")), "requests.log");
    process.env.FAKE_CODEX_LOG = log;
    const session = new CodexSession(base, { executable: fakeCodex });
    sessions.push(session);
    let completed = 0;
    void (async () => {
      for await (const e of session.events as AsyncIterable<AgentEvent>) {
        if (e.type === "turn.completed") completed++;
      }
    })();
    const turn = async (text: string) => {
      const target = completed + 1;
      await session.send({ text, attachments: [] });
      const deadline = Date.now() + 5000;
      while (completed < target) {
        if (Date.now() > deadline) throw new Error(`turn "${text}" did not complete`);
        await new Promise((r) => setTimeout(r, 10));
      }
    };
    await session.start();
    const start = requests(log).find((r) => r.method === "thread/start");
    expect(start?.params).toMatchObject({
      approvalPolicy: "on-request",
      sandbox: "workspace-write",
    });
    const config = (start?.params.config ?? {}) as Record<string, unknown>;
    expect(config["sandbox_workspace_write.writable_roots"]).toEqual([...osTempRoots()]);

    await turn("first");
    await session.setAutonomy("full");
    await turn("second");
    await turn("third");
    await session.setAutonomy("supervised");
    await turn("fourth");

    const turns = requests(log).filter((r) => r.method === "turn/start");
    expect(turns.map((t) => t.params.approvalPolicy)).toEqual([
      "on-request",
      "on-request",
      "on-request",
      "untrusted",
    ]);
    // The first turn too (#654): a thread Codex keeps loaded ignores thread/resume's sandbox.
    expect(turns[0]?.params.sandboxPolicy).toMatchObject({
      type: "workspaceWrite",
      networkAccess: false,
    });
    expect(turns[1]?.params.sandboxPolicy).toEqual({
      type: "workspaceWrite",
      writableRoots: [...osTempRoots()],
      networkAccess: true,
      excludeTmpdirEnvVar: false,
      excludeSlashTmp: false,
    });
    expect(turns[3]?.params.sandboxPolicy).toMatchObject({
      type: "workspaceWrite",
      writableRoots: [],
      networkAccess: false,
    });
  });
});

describe("Fake autonomy changes", () => {
  it("skips the scripted command approval once the session is on full", async () => {
    const session = (await new FakeProvider().openSession(base)) as FakeSession;
    const events: AgentEvent[] = [];
    void (async () => {
      for await (const e of session.events) events.push(e);
    })();
    await session.setAutonomy("full");
    expect(session.autonomy).toBe("full");
    await session.send({ text: "go [approval]", attachments: [] });
    const deadline = Date.now() + 5000;
    while (!events.some((e) => e.type === "turn.completed")) {
      if (Date.now() > deadline) throw new Error("turn did not complete");
      await new Promise((r) => setTimeout(r, 10));
    }
    expect(
      events.some((e) => e.type === "item.started" && e.item.kind === "approval_request"),
    ).toBe(false);
    await session.close();
  });
  it("warns when Codex reports another sandbox than the one asked for, and still sends it", async () => {
    const dir = mkdtempSync(join(tmpdir(), "agent-rishi-codex-sandbox-"));
    const log = join(dir, "requests.log");
    process.env.FAKE_CODEX_LOG = log;
    process.env.FAKE_CODEX_SANDBOX = "readOnly";
    // Notices wait for the turn's `turn/started`, which the fake sends only when scripted.
    const scripted = join(dir, "scripted.json");
    const started = { turn: { id: "turn-1", status: "inProgress", items: [], error: null } };
    writeFileSync(
      scripted,
      JSON.stringify([{ notify: true, method: "turn/started", params: started }]),
    );
    process.env.FAKE_CODEX_REQUESTS = scripted;
    const session = new CodexSession({ ...base, autonomy: "full" }, { executable: fakeCodex });
    sessions.push(session);
    const notices: string[] = [];
    let completed = false;
    void (async () => {
      for await (const e of session.events as AsyncIterable<AgentEvent>) {
        if (e.type === "item.completed" && e.item.kind === "notice" && e.item.code) {
          notices.push(e.item.code);
        }
        if (e.type === "turn.completed") completed = true;
      }
    })();
    await session.start();
    await session.send({ text: "edit a file", attachments: [] });
    const deadline = Date.now() + 5000;
    while (!completed) {
      if (Date.now() > deadline) throw new Error("turn did not complete");
      await new Promise((r) => setTimeout(r, 10));
    }
    expect(notices).toEqual(["sandbox_mismatch"]);
    const turn = requests(log).find((r) => r.method === "turn/start");
    expect(turn?.params.sandboxPolicy).toMatchObject({
      type: "workspaceWrite",
      networkAccess: true,
    });
  });
});
