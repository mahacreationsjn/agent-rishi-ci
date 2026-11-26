import type { Project, StartWorkspaceRequest, WorkspaceRequest } from "@agent-rishi/contracts";
import { badRequest } from "../errors";

type GitFacts = Pick<Project, "path" | "isGitRepo">;

/**
 * Refuse a new worktree in a project folder that isn't a git repository (`Project.isGitRepo`,
 * §9): when the session is created, never on its first turn. Its sessions run in the folder.
 */
export function requireGitRepo(project: GitFacts): void {
  if (project.isGitRepo) return;
  throw badRequest(
    `${project.path} is not a git repository: sessions run in the project folder`,
    "not_a_repo",
  );
}

/**
 * The workspace a new session prepares (§9): the one asked for, with its mode picked from the
 * project when the request leaves it out: a new worktree when the project folder is a git
 * repository, the project folder itself when it isn't (`Project.isGitRepo`). A worktree asked
 * for in a folder that isn't one is refused (`requireGitRepo`). Sessions without a project (the
 * orchestrator) run in their own folder whatever the mode.
 */
export function startWorkspace(
  req: StartWorkspaceRequest,
  project: GitFacts | null,
): WorkspaceRequest {
  const mode = req.mode ?? (project && !project.isGitRepo ? "repo_root" : "worktree");
  if (project && mode === "worktree") requireGitRepo(project);
  return { ...req, mode };
}
