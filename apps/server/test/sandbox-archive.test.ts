import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type RunningRunner, startRunner } from "@agent-rishi/runner";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type RunningServer, startServer } from "../src";
import { BackendError } from "../src/execution/backend";
import { type Exec, runTool } from "../src/services/exec";
import type { GitBroker } from "../src/services/git-broker";
import { cleanupInboxId } from "../src/services/sessions/worktree-cleanup";
import { waitUntil } from "./support/harness";
import { removeTree } from "./support/remove-tree";
import { ScriptedBackend } from "./support/scripted-backend";

/**
 * Archiving a session that runs in a container (#337, `docs/remote-runners.md` §5.2): the
 * container's clone is the only copy of its commits until they are pushed, so archive keeps the
 * container and its volume while the clone has uncommitted changes, unpushed commits or stashes,
 * or can't be checked, unless forced. The backend is scripted: its "container" is an in-process
 * runner with its own home. No Docker runs in `pnpm test`.
 */

const TOKEN = "f".repeat(64);
const IDENTITY = ["-c", "user.name=Test", "-c", "user.email=test@example.com"];
const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", [...IDENTITY, "-c", "core.autocrlf=false", ...args], {
    cwd,
    encoding: "utf8",
    windowsHide: true,
  }).trim();
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
let bare: string;
let runner: RunningRunner;
let backend: ScriptedBackend;
let server: RunningServer;
let projectId: string;

async function api(method: string, path: string, body?: unknown) {
  const res = await fetch(`${server.url}/api${path}`, {
    method,
    headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

beforeEach(async () => {
  base = mkdtempSync(join(tmpdir(), "agent-rishi-sandbox-archive-"));
  const serverHome = mkdtempSync(join(base, "server-"));
  const runnerHome = mkdtempSync(join(base, "container-"));
  bare = mkdtempSync(join(base, "origin-"));
  const work = mkdtempSync(join(base, "project-"));
  git(bare, "init", "-q", "--bare", "-b", "main");
  git(work, "init", "-q", "-b", "main");
  writeFileSync(join(work, "README.md"), "# sandboxed\n");
  git(work, "add", "-A");
  git(work, "commit", "-q", "-m", "initial");
  git(work, "remote", "add", "origin", bare);
  git(work, "push", "-q", "origin", "main");
  git(work, "remote", "set-url", "origin", "https://github.com/agent-rishi-test/sandboxed.git");

  runner = await startRunner({
    home: runnerHome,
    enableFakeProvider: true,
    builtinProviders: false,
    backend: "docker",
  });
  backend = new ScriptedBackend(runnerHome);
  const gitBroker: GitBroker = {
    cloneUrl: async () => bare,
    credentialFor: async () => undefined,
    credentialForProject: async () => undefined,
  };
  server = await startServer({
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
  });
  const { project } = await server.services.projects.create({
    source: { type: "local", path: work },
  });
  projectId = project.id;
  const patched = await api("PATCH", `/projects/${projectId}`, {
    execution: { backend: "docker" },
  });
  expect(patched.status).toBe(200);
});

afterEach(async () => {
  await server.close();
  await runner.close();
  await removeTree(base);
});

/** Start an agent session in its container and wait for its first turn to finish. */
async function startIdleSession(
  text = "work in a container",
): Promise<{ id: string; cwd: string }> {
  const started = await api("POST", "/sessions", {
    projectId,
    provider: "fake",
    input: { text, attachments: [] },
  });
  expect(started.body.status).toBe("started");
  const id = started.body.sessionId as string;
  await server.services.sessions.launching.get(id);
  await waitUntil(() => server.services.sessionRepo.get(id).status === "idle");
  return { id, cwd: server.services.sessionRepo.get(id).cwd };
}

/** Commit a new file in the clone; returns its branch. */
function commitInClone(cwd: string, file: string): string {
  writeFileSync(join(cwd, file), `${file}\n`);
  git(cwd, "add", "-A");
  git(cwd, "commit", "-q", "-m", `add ${file}`);
  return git(cwd, "rev-parse", "--abbrev-ref", "HEAD");
}

const archive = async (id: string, force = false) =>
  (await api("POST", `/sessions/${id}/archive`, { force })).body as {
    worktree: { status: string; message: string | null; unpushed?: unknown };
  };

describe("archiving a session in a container", () => {
  it("keeps the container and volume when the clone has commits it never pushed", async () => {
    const { id, cwd } = await startIdleSession();
    const branch = commitInClone(cwd, "feature.md");

    const { worktree } = await archive(id);

    expect(backend.removed).toEqual([]);
    expect(worktree.status).toBe("kept_changes");
    expect(worktree.message).toContain(`1 unpushed commit on ${branch}`);
    expect(worktree.unpushed).toEqual({
      current: branch,
      uncommitted: 0,
      branches: [{ name: branch, commits: 1 }],
      stashes: 0,
    });
    expect(server.services.sessionRepo.get(id).archivedAt).not.toBeNull();
  });

  it("keeps it for uncommitted changes and for a stash", async () => {
    const { id, cwd } = await startIdleSession();
    writeFileSync(join(cwd, "draft.md"), "not committed\n");
    const dirty = await archive(id);
    expect(dirty.worktree.status).toBe("kept_changes");
    expect(dirty.worktree.message).toContain("uncommitted changes in 1 file");

    git(cwd, "stash", "push", "-q", "-u", "-m", "half done");
    const stashed = await archive(id);
    expect(stashed.worktree.status).toBe("kept_changes");
    expect(stashed.worktree.message).toContain("1 stash");
    expect(backend.removed).toEqual([]);
  });

  it("removes it once the commits are pushed (Push the branch first)", async () => {
    const { id, cwd } = await startIdleSession();
    const branch = commitInClone(cwd, "feature.md");
    expect((await archive(id)).worktree.status).toBe("kept_changes");

    // The archived session's runner still answers: its branch is pushed through the server.
    const pushed = await api("POST", `/sessions/${id}/git/push`, {});
    expect(pushed.body).toEqual({ remote: "origin", branch });
    expect(git(bare, "rev-parse", branch)).toBe(git(cwd, "rev-parse", "HEAD"));

    const { worktree } = await archive(id);
    expect(worktree).toEqual({ status: "removed", message: null });
    expect(backend.removed).toHaveLength(1);
  });

  it("removes it when forced, saying what was deleted with it", async () => {
    const { id, cwd } = await startIdleSession();
    const branch = commitInClone(cwd, "feature.md");

    const { worktree } = await archive(id, true);

    expect(worktree.status).toBe("removed");
    expect(worktree.message).toBe(`Deleted with the container: 1 unpushed commit on ${branch}`);
    expect(backend.removed).toHaveLength(1);
  });

  it("starts a stopped container to check its clone", async () => {
    const { id, cwd } = await startIdleSession();
    commitInClone(cwd, "feature.md");
    backend.stopSandbox();
    await waitUntil(() => !server.services.runners.forSession(id).isConnected());
    backend.calls = [];

    const { worktree } = await archive(id);

    expect(backend.calls).toEqual(["state", "start"]);
    expect(worktree.status).toBe("kept_changes");
    expect(backend.removed).toEqual([]);
  });

  it("keeps the volume when the container can't be reached to check", async () => {
    const { id } = await startIdleSession();
    backend.stopSandbox();
    backend.failStart = new BackendError("Docker failed starting the container: no such image");
    await waitUntil(() => !server.services.runners.forSession(id).isConnected());

    const { worktree } = await archive(id);

    expect(worktree.status).toBe("failed");
    expect(worktree.message).toContain("couldn't be started to check its clone");
    expect(worktree.message).toContain("The container and its volume were kept");
    expect(backend.removed).toEqual([]);
  });

  it("archiving the project keeps and lists the containers with unpushed work", async () => {
    const pushed = await startIdleSession("nothing to keep");
    // Each container is a runner of its own.
    const second = await startRunner({
      home: mkdtempSync(join(base, "container2-")),
      enableFakeProvider: true,
      builtinProviders: false,
      backend: "docker",
    });
    try {
      backend.runnerHome = join(second.lockFile, "..", "..");
      const unpushed = await startIdleSession("commits and never pushes");
      const branch = commitInClone(unpushed.cwd, "feature.md");

      const result = await server.services.worktreeCleanup.cleanProject(projectId);

      expect(result.removed).toEqual([pushed.id]);
      expect(result.kept).toEqual([
        {
          sessionId: unpushed.id,
          message: expect.stringContaining(`1 unpushed commit on ${branch}`),
        },
      ]);
      expect(backend.removed).toHaveLength(1);
      const item = server.services.inbox.find(cleanupInboxId(unpushed.id));
      expect(item).toMatchObject({ kind: "cleanup_failed", status: "open", notify: "needs_you" });
      expect(item?.body).toContain(`1 unpushed commit on ${branch}`);

      // Removed later (here: forced), its item is resolved.
      await archive(unpushed.id, true);
      expect(server.services.inbox.find(cleanupInboxId(unpushed.id))?.status).toBe("resolved");
    } finally {
      await second.close();
    }
  });
});
