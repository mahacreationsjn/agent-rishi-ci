import type { Project, Session, WorkspaceRequest } from "@agent-rishi/contracts";
import { ServiceError } from "../errors";
import type { GitBroker } from "../git-broker";
import type { RunnerPort } from "../runner-port";
import { slugWords } from "./conflicts";
import { type SetupGateDeps, seenSetups, settleSetup } from "./setup-gate";

/** What a prepared workspace is recorded as on the session. */
export interface PreparedWorkspace {
  cwd: string;
  worktreePath: string | null;
  branch: string | null;
  baseBranch: string | null;
  /** Why the requested workspace could not be used, when Agent Rishi fell back. */
  fallback: string | null;
  /** A failed setup command, told to the agent with its first input. */
  setupNote: string | null;
}

/**
 * The workspace of a session on a runner that doesn't share the server's disk (a sandbox,
 * `docs/remote-runners.md` §9.1): the runner clones the project's `origin` into a folder it
 * chooses and checks out the session's branch (a new one, as for a worktree, or the default
 * branch for a `repo_root` session). The server never builds a path for it: `cwd` is whatever
 * the runner returns, and there is no worktree to clean up (the clone lives as long as its
 * sandbox). The credential for the clone is brokered for that one operation (§9.2).
 */
export async function prepareCloneWorkspace(
  git: GitBroker | undefined,
  runner: RunnerPort,
  session: Session,
  project: Project,
  req: WorkspaceRequest,
  opts: { fork: boolean; gate: SetupGateDeps },
): Promise<PreparedWorkspace> {
  if (opts.fork) {
    throw new ServiceError(
      400,
      "unsupported",
      "A session on a runner in a sandbox can't be forked yet",
    );
  }
  if (req.mode === "existing") {
    throw new ServiceError(
      400,
      "unsupported",
      "A runner in a sandbox can't use a folder on this machine; start it in a new worktree",
    );
  }
  const remoteUrl = git ? await git.cloneUrl(project) : null;
  if (!git || !remoteUrl) {
    throw new ServiceError(
      400,
      "clone_unavailable",
      "This project has no origin remote, so a runner in a sandbox can't clone it",
    );
  }
  const baseRef = req.baseRef ?? project.defaultBranch ?? undefined;
  const branch = req.detachedCommit
    ? undefined
    : (req.branch ??
      (req.mode === "worktree"
        ? `agent-rishi/${slugWords(session.title ?? session.purpose, 5, 40)}-${session.id.slice(0, 4)}`
        : baseRef));
  const credential = await git.credentialFor(runner, remoteUrl);
  const result = await runner.request(
    {
      name: "workspace.prepare",
      sessionId: session.id,
      strategy: "clone",
      remoteUrl,
      branch,
      baseRef,
      ...(req.detachedCommit ? { detachedCommit: req.detachedCommit } : {}),
      fetch: true,
      setupCommands: req.setupCommands ?? [],
      seenSetups: seenSetups(project),
      ...(credential ? { credential } : {}),
    },
    opts.gate.timeoutMs,
  );
  return {
    cwd: result.cwd,
    worktreePath: null,
    branch: result.branch,
    baseBranch: req.mode === "worktree" ? (baseRef ?? null) : null,
    fallback: null,
    setupNote: await settleSetup(opts.gate, session, project, result),
  };
}
