import { join } from "node:path";
import type { RunnerCommandName, RunnerCommandOf } from "@agent-rishi/contracts";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { McpTokenStore } from "../src/mcp/tokens";
import type { ProjectService } from "../src/services/projects/project-service";
import type { RunnerPort } from "../src/services/runner-port";
import { SessionLauncher } from "../src/services/sessions/launcher";
import { createGithubEnv, type GithubEnv } from "./support/github-env";

let env: GithubEnv;
let calls: Array<RunnerCommandOf<RunnerCommandName>>;
let launcher: SessionLauncher;
/** When set, `workspace.prepare` fails with it (a worktree git can't make). */
let prepareError: Error | null;

beforeEach(() => {
  env = createGithubEnv();
  calls = [];
  prepareError = null;
  const runner = {
    isConnected: () => true,
    runnerId: () => "r1",
    providers: () => [],
    mcpProxyUrl: () => null,
    waitForConnection: async () => true,
    request: (async (command: RunnerCommandOf<RunnerCommandName>) => {
      calls.push(command);
      if (command.name === "workspace.prepare") {
        if (prepareError) throw prepareError;
        return { cwd: command.path ?? env.dir, branch: command.branch ?? null, created: true };
      }
      return { resumeToken: null };
    }) as RunnerPort["request"],
  } as unknown as RunnerPort;
  const projects = {
    get: (id: string) => (id === env.githubProject.id ? env.githubProject : env.localProject),
  } as unknown as ProjectService;
  launcher = new SessionLauncher({
    repo: env.repo,
    projects,
    runner,
    inbox: env.inbox,
    home: env.dir,
    worktreesDir: join(env.dir, "wt"),
    orchestratorDir: join(env.dir, "orchestrator"),
    tokens: { mint: () => "token" } as unknown as McpTokenStore,
  });
});

afterEach(() => env.close());

const prepared = () => {
  const call = calls.find((c) => c.name === "workspace.prepare");
  if (call?.name !== "workspace.prepare") throw new Error("no workspace.prepare");
  return call;
};

describe("new worktrees of a GitHub project", () => {
  it("fetch first, so they can start from the up-to-date default branch", async () => {
    const session = env.addSession({ status: "starting", worktreePath: null, branch: null });
    await launcher.launch(session.id, { workspace: { mode: "worktree" } });
    expect(prepared()).toMatchObject({ baseRef: "main", fetch: true });
    // The pull request still targets the default branch.
    expect(env.repo.get(session.id).baseBranch).toBe("main");
  });

  it("keep an explicit base ref and the caller's fetch choice", async () => {
    const session = env.addSession({ status: "starting", worktreePath: null, branch: null });
    await launcher.launch(session.id, { workspace: { mode: "worktree", baseRef: "release" } });
    expect(prepared()).toMatchObject({ baseRef: "release" });
    expect(prepared().fetch).toBeUndefined();
  });

  it("are made by the next start when the first couldn't make them, never skipped (#408)", async () => {
    const session = env.addSession({
      status: "starting",
      cwd: env.githubProject.path,
      worktreePath: null,
      branch: null,
    });
    const opened = () => calls.filter((c) => c.name === "session.start");
    const text = (t: string) => ({ text: t, attachments: [] });
    prepareError = Object.assign(new Error("fatal: invalid reference: release"), {
      code: "git_failed",
    });
    await launcher.launch(session.id, {
      input: text("first"),
      workspace: { mode: "worktree", baseRef: "release" },
    });
    expect(env.repo.get(session.id).status).toBe("failed");

    // Still can't be made: the next message is refused, not opened in the project folder.
    await expect(launcher.resume(env.repo.get(session.id), text("second"))).rejects.toThrow(
      "invalid reference",
    );
    expect(opened()).toHaveLength(0);

    // Now it can: the same worktree is made, then the session opens in it.
    prepareError = null;
    await launcher.resume(env.repo.get(session.id), text("third"));
    expect(calls.filter((c) => c.name === "workspace.prepare")).toHaveLength(3);
    expect(prepared()).toMatchObject({ strategy: "worktree", baseRef: "release" });
    const worktree = env.repo.get(session.id).worktreePath;
    expect(worktree).toBe(prepared().path);
    const [start] = opened();
    expect(start?.name === "session.start" && start.options.cwd).toBe(worktree);

    // Prepared once: later starts open it where it is.
    await launcher.resume(env.repo.get(session.id));
    expect(calls.filter((c) => c.name === "workspace.prepare")).toHaveLength(3);
    expect(opened()).toHaveLength(2);
  });

  it("are not fetched for local-only projects", async () => {
    const session = env.addSession({
      status: "starting",
      projectId: env.localProject.id,
      worktreePath: null,
      branch: null,
    });
    await launcher.launch(session.id, { workspace: { mode: "worktree" } });
    expect(prepared().fetch).toBeUndefined();
  });
});
