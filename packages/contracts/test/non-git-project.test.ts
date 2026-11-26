import { describe, expect, it } from "vitest";
import { Project, SessionStartMeta, StartSessionRequest, WorkspaceRequest } from "../src";
import { sampleProject } from "./fixtures";

function roundTrip<T>(schema: { parse: (v: unknown) => T }, value: unknown): T {
  const first = schema.parse(value);
  const second = schema.parse(JSON.parse(JSON.stringify(first)));
  expect(second).toEqual(first);
  return second;
}

// #408: a project folder that isn't a git repository has no worktrees.
describe("projects that aren't git repositories", () => {
  it("count as git repositories when written before the flag existed", () => {
    const { isGitRepo: _g, ...rest } = sampleProject;
    expect(Project.parse(rest).isGitRepo).toBe(true);
  });

  it("round-trips a project whose folder isn't a git repository", () => {
    expect(roundTrip(Project, { ...sampleProject, isGitRepo: false }).isGitRepo).toBe(false);
    expect(Project.safeParse({ ...sampleProject, isGitRepo: "no" }).success).toBe(false);
  });

  it("leaves a start's workspace mode to the server unless it names one", () => {
    expect(roundTrip(StartSessionRequest, { projectId: "p1" }).workspace.mode).toBeUndefined();
    const named = roundTrip(StartSessionRequest, {
      projectId: "p1",
      workspace: { mode: "repo_root" },
    });
    expect(named.workspace).toEqual({ mode: "repo_root" });
    expect(
      StartSessionRequest.safeParse({ projectId: "p1", workspace: { mode: "folder" } }).success,
    ).toBe(false);
  });

  it("keeps the worktree default where a workspace is stored", () => {
    expect(WorkspaceRequest.parse({}).mode).toBe("worktree");
    const meta = { workspaceFallback: null, forced: null, queuedBehind: [] };
    expect(SessionStartMeta.parse(meta).workspaceMode).toBe("worktree");
    expect(roundTrip(SessionStartMeta, { ...meta, workspaceMode: "repo_root" }).workspaceMode).toBe(
      "repo_root",
    );
  });
});
