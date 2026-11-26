import { describe, expect, it } from "vitest";
import { requireGitRepo, startWorkspace } from "../src/services/sessions/start-workspace";

const git = { path: "/work/app", isGitRepo: true };
const folder = { path: "/work/music-videos", isGitRepo: false };

// #408: a project folder that isn't a git repository never gets a worktree session.
describe("startWorkspace", () => {
  it("gives a git project a worktree unless the start names another workspace", () => {
    expect(startWorkspace({}, git)).toEqual({ mode: "worktree" });
    expect(startWorkspace({ baseRef: "dev" }, git)).toEqual({ mode: "worktree", baseRef: "dev" });
    expect(startWorkspace({ mode: "repo_root" }, git)).toEqual({ mode: "repo_root" });
  });

  it("runs in the folder of a project that isn't a git repository", () => {
    expect(startWorkspace({}, folder)).toEqual({ mode: "repo_root" });
    expect(startWorkspace({ mode: "repo_root" }, folder)).toEqual({ mode: "repo_root" });
    expect(startWorkspace({ mode: "existing", path: "/elsewhere" }, folder)).toEqual({
      mode: "existing",
      path: "/elsewhere",
    });
  });

  it("refuses a worktree there with not_a_repo", () => {
    expect(() => startWorkspace({ mode: "worktree" }, folder)).toThrow(
      expect.objectContaining({
        status: 400,
        code: "not_a_repo",
        message: "/work/music-videos is not a git repository: sessions run in the project folder",
      }),
    );
    expect(() => requireGitRepo(folder)).toThrow(expect.objectContaining({ code: "not_a_repo" }));
    expect(() => requireGitRepo(git)).not.toThrow();
  });

  it("leaves sessions without a project (the orchestrator) as they were", () => {
    expect(startWorkspace({}, null)).toEqual({ mode: "worktree" });
  });
});
