import type {
  GitHubRepo,
  Project,
  ProjectDetection,
  ProjectRefreshOutcome,
} from "@agent-rishi/contracts";

/** The result of applying a fresh detection to a stored project. */
export interface Reconciled {
  /** The project to keep: the input object itself unless `changed`. */
  project: Project;
  changed: boolean;
  outcome: ProjectRefreshOutcome;
  /** One line for the UI. */
  message: string;
}

/** Facts about the folder that `ProjectDetection` does not carry. */
export interface ReconcileFacts {
  now: string;
  /** `.git` exists in the folder, so a failed detection means git failed, not "no checkout". */
  gitDirPresent: boolean;
  /** The detected git root is the project folder itself (not a parent checkout). */
  ownCheckout: boolean;
}

const label = (r: Pick<GitHubRepo, "owner" | "repo">) => `${r.owner}/${r.repo}`;

/** Same GitHub repository; GitHub owner and repository names are case-insensitive. */
export function sameGithubRepo(
  a: Pick<GitHubRepo, "owner" | "repo">,
  b: Pick<GitHubRepo, "owner" | "repo">,
): boolean {
  return (
    a.owner.toLowerCase() === b.owner.toLowerCase() && a.repo.toLowerCase() === b.repo.toLowerCase()
  );
}

const keeping =
  (project: Project) =>
  (outcome: ProjectRefreshOutcome, message: string): Reconciled => ({
    project,
    changed: false,
    outcome,
    message,
  });

/**
 * Apply what re-detecting a project's folder found (§9). Pure: the caller appends the event.
 *
 * - local → GitHub: a GitHub `origin` upgrades the project to `kind: "github"`.
 * - not a git checkout → checkout: the default branch is recorded, so worktrees work.
 * - another GitHub repository (or URL) on `origin`: the coordinates follow it.
 * - a GitHub project without a GitHub `origin`: never downgraded; a `remoteWarning` is set and
 *   the user decides (restore the remote, or disconnect GitHub).
 * - `isGitRepo` follows the folder, so its new sessions get worktrees or run in place. A `.git`
 *   that git couldn't read changes nothing.
 */
export function reconcileProject(
  project: Project,
  detected: ProjectDetection,
  facts: ReconcileFacts,
): Reconciled {
  const keep = keeping(project);
  if (!detected.isGitRepo && facts.gitDirPresent) {
    return keep(
      "unchanged",
      `Couldn't read the git checkout in ${project.path}; is git installed?`,
    );
  }
  if (detected.isGitRepo && !facts.ownCheckout) {
    return keep(
      "unchanged",
      `This folder is inside the git checkout at ${detected.gitRoot}; add that folder as a project to use its remote`,
    );
  }
  const result = reconcileRemote(project, detected, facts);
  const isGitRepo = detected.isGitRepo;
  if (result.project.isGitRepo === isGitRepo) return result;
  if (result.changed) return { ...result, project: { ...result.project, isGitRepo } };
  return {
    project: { ...project, isGitRepo, updatedAt: facts.now },
    changed: true,
    outcome: isGitRepo ? "git_detected" : "git_missing",
    message: isGitRepo
      ? "Found a git repository: new sessions get their own worktree"
      : "Not a git repository: sessions run in the project folder",
  };
}

/** The kind, GitHub coordinates and default branch, from a detection of the project's own folder. */
function reconcileRemote(
  project: Project,
  detected: ProjectDetection,
  facts: ReconcileFacts,
): Reconciled {
  const keep = keeping(project);
  const update = (next: Project, outcome: ProjectRefreshOutcome, message: string): Reconciled => ({
    project: { ...next, updatedAt: facts.now },
    changed: true,
    outcome,
    message,
  });

  const gh = detected.github;
  if (project.kind === "github") {
    const { remoteWarning, ...current } = project;
    if (!gh) {
      const remoteUrl = detected.isGitRepo ? detected.remoteUrl : null;
      const message = remoteUrl
        ? `origin now points to ${remoteUrl}, not GitHub; GitHub features still use ${label(project.github)}`
        : `This folder has no GitHub remote on origin any more; GitHub features still use ${label(project.github)}`;
      if (remoteWarning && remoteWarning.remoteUrl === remoteUrl) {
        return keep("github_remote_missing", message);
      }
      return update(
        {
          ...project,
          remoteWarning: { code: "github_remote_missing", remoteUrl, detectedAt: facts.now },
        },
        "github_remote_missing",
        message,
      );
    }
    if (!sameGithubRepo(project.github, gh)) {
      return update(
        { ...current, github: gh },
        "github_changed",
        `Now connected to ${label(gh)} (was ${label(project.github)})`,
      );
    }
    if (project.github.remoteUrl !== gh.remoteUrl) {
      // Same repository, new URL (https ↔ ssh, a rename's new casing): keep the default branch.
      const github = { ...project.github, owner: gh.owner, repo: gh.repo, remoteUrl: gh.remoteUrl };
      return update(
        { ...current, github },
        "github_changed",
        `Updated the remote of ${label(gh)} to ${gh.remoteUrl}`,
      );
    }
    if (remoteWarning) {
      return update(current, "github_connected", `Connected to ${label(project.github)} again`);
    }
    return keep("unchanged", `Connected to ${label(project.github)}`);
  }

  if (gh) {
    return update(
      {
        ...project,
        kind: "github",
        github: gh,
        defaultBranch: project.defaultBranch ?? gh.defaultBranch,
      },
      "github_connected",
      `Connected to ${label(gh)}`,
    );
  }
  if (!detected.isGitRepo) {
    return keep("unchanged", "Not a git repository yet, so there is no GitHub remote");
  }
  const elsewhere = detected.remoteUrl ? ` (origin is ${detected.remoteUrl}, not GitHub)` : "";
  if (project.defaultBranch === null && detected.defaultBranch) {
    return update(
      { ...project, defaultBranch: detected.defaultBranch },
      "git_detected",
      `Found a git repository on ${detected.defaultBranch}; still no GitHub remote on origin${elsewhere}`,
    );
  }
  return keep("unchanged", `Still no GitHub remote on origin${elsewhere}`);
}
