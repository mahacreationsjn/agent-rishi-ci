import type { Session } from "@agent-rishi/contracts";
import { ApiRequestError } from "@/lib/api";

/**
 * Whether a session gets the right panel and its toggle (§13): every agent session once its
 * workspace is ready, whether that is its own worktree or the project folder it runs in place
 * in. Subagents, the browser, files, the terminal and details don't need git; the Diff tab says
 * so itself when the folder isn't a git repository (`isNotGitRepo`).
 *
 * Without a worktree, the session must have been opened (`rootThreadId`, set when the provider
 * starts its root thread, after the workspace is recorded): a new worktree session is queued or
 * starting with `worktreePath` null and `cwd` still the user's own checkout until `workspace.prepare`
 * returns, and its panel must not show that checkout's branch, changes or Commit and Push.
 */
export function hasRightPanel(session: Session | undefined): boolean {
  if (session?.role !== "agent") return false;
  return session.worktreePath !== null || session.rootThreadId !== null;
}

/**
 * True for the error of a git request (status, diff) in a folder that isn't a git repository:
 * the runner answers `not_a_repo`.
 */
export function isNotGitRepo(error: unknown): boolean {
  return error instanceof ApiRequestError && error.code === "not_a_repo";
}
