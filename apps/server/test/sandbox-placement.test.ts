import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { type RunningRunner, startRunner } from "@agent-rishi/runner";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type RunningServer, type StartServerOptions, startServer } from "../src";
import { BackendError } from "../src/execution/backend";
import { CREDENTIALS_UNAVAILABLE } from "../src/execution/sandboxes";
import { type Exec, runTool } from "../src/services/exec";
import type { GitBroker } from "../src/services/git-broker";
import { waitUntil } from "./support/harness";
import { storedReply } from "./support/link-turn";
import { removeTree } from "./support/remove-tree";
import { ScriptedBackend } from "./support/scripted-backend";

/**
 * Remote runners phase 4a (#309, `docs/remote-runners.md` §8, §16): a project whose
 * `execution.backend` is `docker` gets a sandbox of its own for each new agent session. The
 * backend is scripted: its "container" is an in-process runner with its own home and backend
 * `docker`, reached through `agent-rishi runner-link`'s code. No Docker runs in `pnpm test`.
 */

const TOKEN = "e".repeat(64);
const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", args, { cwd, encoding: "utf8", windowsHide: true }).trim();
/** git for project detection; every other tool is missing. */
const gitOnly: Exec = (command, args, opts) =>
  command === "git"
    ? runTool(command, args, opts)
    : Promise.resolve({
        code: null,
        stdout: "",
        stderr: "",
        notFound: true,
        timedOut: false,
        path: null,
      });

let base: string;
let serverHome: string;
let runnerHome: string;
let bare: string;
let work: string;
let runner: RunningRunner;
let backend: ScriptedBackend;
let server: RunningServer;
let projectId: string;
/** Where the broker says the project clones from. */
let cloneFrom: string;

function serverOptions(): StartServerOptions {
  const gitBroker: GitBroker = {
    cloneUrl: async () => cloneFrom,
    credentialFor: async () => undefined,
    credentialForProject: async () => undefined,
  };
  return {
    port: 0,
    dataDir: serverHome,
    token: TOKEN,
    runner: false,
    enableFakeProvider: true,
    secrets: "memory",
    checkSetupOnStart: false,
    userHome: serverHome,
    exec: gitOnly,
    github: { sync: false },
    gitBroker,
    executionBackends: { docker: backend },
  };
}

async function api(method: string, path: string, body?: unknown) {
  const res = await fetch(`${server.url}/api${path}`, {
    method,
    headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

/** Start an agent session on the Fake provider; resolves once its start has run. */
async function startSession(text: string, provider = "fake"): Promise<string> {
  const started = await api("POST", "/sessions", {
    projectId,
    provider,
    input: { text, attachments: [] },
  });
  expect(started.body.status).toBe("started");
  const id = started.body.sessionId as string;
  await server.services.sessions.launching.get(id);
  return id;
}

/** Every assistant reply the session completed, oldest first. */
function replies(sessionId: string): string[] {
  return server.store
    .listAfter(0, 100_000, [sessionId])
    .filter((e) => e.type === "agent.item.completed")
    .map((e) => (e.payload as { item?: { kind?: string; text?: string } }).item)
    .filter((item) => item?.kind === "assistant_message")
    .map((item) => item?.text ?? "");
}

const recordOf = (sessionId: string) =>
  server.runners.list().find((r) => r.sessionId === sessionId);

beforeEach(async () => {
  base = mkdtempSync(join(tmpdir(), "agent-rishi-sandbox-"));
  serverHome = mkdtempSync(join(base, "server-"));
  runnerHome = mkdtempSync(join(base, "container-"));
  bare = mkdtempSync(join(base, "origin-"));
  work = mkdtempSync(join(base, "project-"));
  git(bare, "init", "-q", "--bare", "-b", "main");
  git(work, "init", "-q", "-b", "main");
  git(work, "config", "user.name", "Test");
  git(work, "config", "user.email", "test@example.com");
  writeFileSync(join(work, "README.md"), "# sandboxed\n");
  git(work, "add", "-A");
  git(work, "commit", "-q", "-m", "initial");
  git(work, "remote", "add", "origin", bare);
  git(work, "push", "-q", "origin", "main");
  // A GitHub project: the broker clones it from the bare repository above.
  git(work, "remote", "set-url", "origin", "https://github.com/agent-rishi-test/sandboxed.git");
  cloneFrom = bare;

  runner = await startRunner({
    home: runnerHome,
    enableFakeProvider: true,
    builtinProviders: false,
    backend: "docker",
  });
  backend = new ScriptedBackend(runnerHome);
  server = await startServer(serverOptions());
  const { project } = await server.services.projects.create({
    source: { type: "local", path: work },
  });
  expect(project.kind).toBe("github");
  projectId = project.id;
  const patched = await api("PATCH", `/projects/${projectId}`, {
    execution: { backend: "docker" },
  });
  expect(patched.status).toBe(200);
  expect(patched.body.execution).toEqual({ backend: "docker" });
  backend.calls = [];
});

afterEach(async () => {
  await server.close();
  await runner.close();
  await removeTree(base);
});

describe("sessions in a docker project", () => {
  it("get a container of their own, clone there and run their turns over the link", async () => {
    const id = await startSession("hello from a container");
    expect(backend.calls).toEqual(["detect", "prepare", "provision"]);
    const record = recordOf(id);
    expect(record).toMatchObject({ backend: "docker", projectId, state: "connected" });
    expect(record?.sandboxRef).toBe(`agent-rishi-${record?.id}`);
    expect(backend.specs[0]).toMatchObject({
      recordId: record?.id,
      sessionId: id,
      projectId,
      image: "agent-rishi-runner:test",
      cpus: 2,
      memoryMb: 4096,
      fake: true,
    });

    // Routed to the container's runner before the workspace was made: a clone in its home.
    const session = server.services.sessionRepo.get(id);
    expect(session.runnerId).toBe(record?.runnerId);
    expect(session.worktreePath).toBeNull();
    expect(relative(join(runnerHome, "ws"), session.cwd)).not.toMatch(/^\.\./);
    expect(git(session.cwd, "remote", "get-url", "origin")).toBe(bare);
    // MCP goes over the link: the runner's proxy is configured for it.
    expect(server.runners.client(record?.id as string)?.mcpProxyUrl).toBe(runner.mcpUrl);

    await waitUntil(() => server.services.sessionRepo.get(id).status === "idle");
    expect(storedReply(server, id).completed).toContain("hello from a container");
  });

  it("continue in the same container after a server restart", async () => {
    const id = await startSession("before the restart");
    await waitUntil(() => server.services.sessionRepo.get(id).status === "idle");
    const record = recordOf(id);
    await server.close();

    // The container stopped while the server was away: it is started, then linked again.
    backend.sandboxState = "exited";
    backend.calls = [];
    server = await startServer(serverOptions());
    await server.services.sandboxes.reattached;
    expect(backend.calls).toEqual(["state", "start"]);
    const client = server.runners.client(record?.id as string);
    await waitUntil(() => client?.status.state === "connected");
    expect(client?.status.runnerId).toBe(record?.runnerId);

    await server.services.sessions.send(id, {
      input: { text: "after the restart", attachments: [] },
      whenBusy: "queue",
    });
    await waitUntil(() => replies(id).some((text) => text.includes("after the restart")));
    expect(server.services.sessionRepo.get(id).runnerId).toBe(record?.runnerId);
    expect(backend.calls).not.toContain("provision");
  });

  it("lose their container when archived; uncommitted changes keep it unless forced", async () => {
    const id = await startSession("archive me");
    await waitUntil(() => server.services.sessionRepo.get(id).status === "idle");
    const record = recordOf(id);
    const { cwd } = server.services.sessionRepo.get(id);
    writeFileSync(join(cwd, "draft.md"), "not committed\n");

    const kept = await server.services.worktreeCleanup.archive(id);
    expect(kept.worktree.status).toBe("kept_changes");
    expect(backend.removed).toEqual([]);

    const removed = await server.services.worktreeCleanup.archive(id, { force: true });
    expect(removed.worktree.status).toBe("removed");
    expect(backend.removed).toEqual([
      {
        backend: "docker",
        container: `agent-rishi-${record?.id}`,
        volume: `agent-rishi-${record?.id}-data`,
      },
    ]);
    expect(recordOf(id)?.state).toBe("deleted");
    expect(server.runners.client(record?.id as string)).toBeUndefined();
  });

  it("fail with an inbox item, leaving nothing behind, when the container can't be made", async () => {
    backend.failProvision = new BackendError("Docker failed starting the container: no space left");
    const id = await startSession("never runs");
    expect(server.services.sessionRepo.get(id).status).toBe("failed");
    expect(server.services.sessionRepo.get(id).runnerId).toBeNull();
    expect(recordOf(id)).toBeUndefined();
    const item = server.services.inbox.list().find((i) => i.sessionId === id);
    expect(item?.kind).toBe("run_failed");
    expect(item?.body).toContain("no space left");
  });

  it("remove the container when the start fails after it, and get a new one on the next message", async () => {
    cloneFrom = join(base, "no-such-remote");
    const id = await startSession("first try");
    expect(server.services.sessionRepo.get(id).status).toBe("failed");
    expect(server.services.sessionRepo.get(id).runnerId).toBeNull();
    expect(backend.removed).toHaveLength(1);
    expect(recordOf(id)?.state).toBe("deleted");

    // A runner never comes back under a deleted record's id: the next container is a new one.
    const second = await startRunner({
      home: mkdtempSync(join(base, "container2-")),
      enableFakeProvider: true,
      builtinProviders: false,
      backend: "docker",
    });
    try {
      backend.runnerHome = join(second.lockFile, "..", "..");
      cloneFrom = bare;
      await server.services.sessions.send(id, {
        input: { text: "second try", attachments: [] },
        whenBusy: "queue",
      });
      await waitUntil(() => replies(id).some((text) => text.includes("second try")));
      expect(backend.calls.filter((c) => c === "provision")).toHaveLength(2);
      const live = server.runners.list().filter((r) => r.sessionId === id && r.state !== "deleted");
      expect(live).toHaveLength(1);
      expect(server.services.sessionRepo.get(id).runnerId).toBe(live[0]?.runnerId);
    } finally {
      await second.close();
    }
  });

  it("refuse a provider that needs sign-in, removing the container they got", async () => {
    // The home runner isn't there to say what "claude" needs: the container's runner decides.
    const id = await startSession("needs credentials", "claude");
    expect(server.services.sessionRepo.get(id).status).toBe("failed");
    expect(backend.removed).toHaveLength(1);
    expect(recordOf(id)?.state).toBe("deleted");
    const item = server.services.inbox.list().find((i) => i.sessionId === id);
    expect(item?.body).toContain(CREDENTIALS_UNAVAILABLE);
  });
});
