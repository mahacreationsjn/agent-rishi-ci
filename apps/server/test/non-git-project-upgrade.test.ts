import { execFileSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Project, SessionDetail, StartSessionResponse } from "@agent-rishi/contracts";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type RunningServer, startServer } from "../src";
import { findMigrationsDir, openDatabase } from "../src/db/client";
import { type Exec, runTool } from "../src/services/exec";
import { waitUntil } from "./support/harness";
import { removeTree } from "./support/remove-tree";

/**
 * Upgrading to the build that records `Project.isGitRepo` (#408): the migration adds the column
 * as `true` for every project, and the server's start-up check corrects it in the background,
 * one project at a time (#425). A plain-folder project must read as one from the first request
 * (#454), and a session started there before the git check reaches it must run in the project
 * folder, not ask for a worktree.
 */
const TOKEN = "e".repeat(64);
const all = findMigrationsDir();
const names = readdirSync(all).filter((n) => /^\d{14}_/.test(n));
const ts = "2026-11-14T10:00:00.000Z";

let home: string;
/**
 * The first project in the list, a git checkout (so the start-up check runs git there) whose
 * check is slow: it holds up the others.
 */
let slow: string;
/** A plain folder: not a git repository. */
let folder: string;
/** A git checkout. */
let repo: string;
let server: RunningServer | undefined;
let held: (() => void)[];

/** The migrations of the build before #408, which had no `is_git_repo` column. */
function migrationsBeforeIsGitRepo(): string {
  const dir = join(home, "migrations-0.7.4");
  for (const name of names.filter((n) => !n.endsWith("_project_is_git_repo"))) {
    mkdirSync(join(dir, name), { recursive: true });
    copyFileSync(join(all, name, "migration.sql"), join(dir, name, "migration.sql"));
  }
  return dir;
}

/** `git` in the slow project waits until `release()`; everything else runs for real. */
let holding: boolean;
const exec: Exec = (command, args, opts) =>
  holding && command === "git" && args[0] === "-C" && args[1] === slow
    ? new Promise((resolve) => held.push(() => resolve(runTool(command, args, opts))))
    : runTool(command, args, opts);
const release = () => {
  holding = false;
  for (const go of held.splice(0)) go();
};

const api = async (method: string, path: string, body?: unknown) => {
  const res = await fetch(`${server?.url}/api${path}`, {
    method,
    headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, body: (await res.json()) as unknown };
};

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "agent-rishi-upgrade-git-"));
  held = [];
  holding = true;
  slow = join(home, "archive");
  folder = join(home, "music-videos");
  repo = join(home, "todo-app");
  for (const dir of [slow, folder, repo]) mkdirSync(dir);
  writeFileSync(join(folder, "notes.txt"), "lyrics\n");
  for (const dir of [slow, repo]) {
    execFileSync("git", ["-C", dir, "init", "-q", "-b", "main"], { stdio: "pipe" });
  }
  // A database written by the previous build, with its projects in this order.
  const dataDir = join(home, "data");
  mkdirSync(dataDir);
  const old = openDatabase(join(dataDir, "agent-rishi.db"), migrationsBeforeIsGitRepo());
  const insert = old.client.prepare(
    "INSERT INTO projects (id, kind, name, slug, path, default_branch, sort_order, created_at, updated_at) VALUES (?, 'local', ?, ?, ?, ?, ?, ?, ?)",
  );
  insert.run("p0", "archive", "archive", slow, null, 0, ts, ts);
  insert.run("p1", "music-videos", "music-videos", folder, null, 1, ts, ts);
  insert.run("p2", "todo-app", "todo-app", repo, "main", 2, ts, ts);
  old.close();
});

afterEach(async () => {
  release();
  await server?.close();
  server = undefined;
  await removeTree(home);
});

/** Starts the upgraded server and waits until its start-up check is held up on the first project. */
async function startUpgraded(): Promise<void> {
  server = await startServer({
    port: 0,
    dataDir: join(home, "data"),
    token: TOKEN,
    runner: false,
    secrets: "memory",
    checkSetupOnStart: false,
    userHome: home,
    exec,
    github: { sync: false },
  });
  await waitUntil(() => (held.length > 0 ? true : undefined));
}

/** A session start as the New session view sends it, and the workspace it recorded. */
async function startSession(projectId: string, workspace?: { mode: "worktree" }) {
  const res = await api("POST", "/sessions", {
    projectId,
    provider: "fake",
    input: { text: "Hey" },
    ...(workspace ? { workspace } : {}),
  });
  if (res.status !== 200) return { status: res.status, body: res.body, mode: undefined };
  const started = StartSessionResponse.parse(res.body);
  if (started.status !== "started") throw new Error(started.status);
  const detail = SessionDetail.parse((await api("GET", `/sessions/${started.sessionId}`)).body);
  return { status: res.status, body: res.body, mode: detail.startMeta?.workspaceMode };
}

/** What the UI reads about a project: the snapshot (the New session view), then `GET /projects`. */
async function readIsGitRepo(projectId: string) {
  const snapshot = (await api("GET", "/snapshot")).body as { projects: unknown[] };
  const projects = (await api("GET", "/projects")).body as unknown[];
  const find = (list: unknown[]) =>
    list.map((p) => Project.parse(p)).find((p) => p.id === projectId)?.isGitRepo;
  return { snapshot: find(snapshot.projects), list: find(projects) };
}

describe("right after upgrading, before the start-up check reaches the project", () => {
  it("reports a plain folder as not a git repository from the first request (#454)", async () => {
    await startUpgraded();
    // The New session view reads this: `true` would say the session gets its own worktree.
    expect(await readIsGitRepo("p1")).toEqual({ snapshot: false, list: false });
    expect(await readIsGitRepo("p2")).toEqual({ snapshot: true, list: true });
  });

  it("runs a new session in a plain folder in the project folder", async () => {
    await startUpgraded();
    const started = await startSession("p1");
    expect(started.status, JSON.stringify(started.body)).toBe(200);
    expect(started.mode).toBe("repo_root");
    expect(Project.parse((await api("GET", "/projects/p1")).body).isGitRepo).toBe(false);
  });

  it("refuses a worktree there when the session is created, with not_a_repo", async () => {
    await startUpgraded();
    const started = await startSession("p1", { mode: "worktree" });
    expect(started.status).toBe(400);
    expect(started.body).toMatchObject({ error: { code: "not_a_repo" } });
  });

  it("still gives a new session in a git checkout its own worktree", async () => {
    await startUpgraded();
    expect((await startSession("p2")).mode).toBe("worktree");
    expect(Project.parse((await api("GET", "/projects/p2")).body).isGitRepo).toBe(true);
  });
});
