import { errorMessage, ServiceError } from "../errors";
import type { GithubService } from "../github/github-service";
import { prDiffKey } from "./diff-key";
import type { MainSince } from "./github-port";

/**
 * The GitHub calls behind the factory's merge queue and PR ownership (§10.1): how far a PR is
 * behind the default branch and what changed there since, what the default branch's head was at
 * an earlier time, bringing a PR up to date without an agent, closing a PR a rebuild replaced,
 * and whether CI can run on the repository at all.
 */

/** Commits the default branch has that the PR's head doesn't (0: up to date). */
export async function behindBy(
  github: GithubService,
  projectId: string,
  headSha: string,
): Promise<number> {
  const { owner, repo, defaultBranch } = github.githubRepo(projectId);
  return github.client.run(
    async (o) =>
      (
        await o.rest.repos.compareCommitsWithBasehead({
          owner,
          repo,
          basehead: `${defaultBranch}...${headSha}`,
          per_page: 1,
        })
      ).data.behind_by,
  );
}

/**
 * The default branch's newest commit at `at` (GitHub's commit list filtered by commit date: a
 * merge made on GitHub is dated when it merged); null when it had none by then.
 */
export async function mainShaAt(
  github: GithubService,
  projectId: string,
  at: string,
): Promise<string | null> {
  const { owner, repo, defaultBranch } = github.githubRepo(projectId);
  const commits = await github.client.run(
    async (o) =>
      (
        await o.rest.repos.listCommits({
          owner,
          repo,
          sha: defaultBranch,
          until: at,
          per_page: 1,
        })
      ).data,
  );
  return commits[0]?.sha ?? null;
}

/** GitHub's compare lists at most this many files for the whole comparison. */
export const COMPARE_FILE_LIMIT = 300;

/**
 * What the default branch has that `headSha` doesn't: one three-dot compare from the PR's head
 * to the default branch, so `ahead_by` counts the commits the PR is missing and `files` are what
 * they changed since the merge base. With pagination GitHub lists the files on the first page
 * only (up to 300), so one page of one commit is enough.
 */
export async function mainSince(
  github: GithubService,
  projectId: string,
  headSha: string,
): Promise<MainSince> {
  const { owner, repo, defaultBranch } = github.githubRepo(projectId);
  const data = await github.client.run(
    async (o) =>
      (
        await o.rest.repos.compareCommitsWithBasehead({
          owner,
          repo,
          basehead: `${headSha}...${defaultBranch}`,
          per_page: 1,
        })
      ).data,
  );
  const listed = data.files ?? [];
  const files = new Set<string>();
  for (const f of listed) {
    files.add(f.filename);
    if (f.previous_filename) files.add(f.previous_filename);
  }
  return {
    behind: data.ahead_by,
    files: [...files],
    complete: listed.length < COMPARE_FILE_LIMIT,
  };
}

/** Fingerprints kept per port (a commit's own change never changes, so they never go stale). */
const DIFF_KEYS_KEPT = 64;

/**
 * The fingerprint of what the PR at `headSha` itself changes (`prDiffKey`, §10.1 Review). It is
 * read from a three-dot compare pinned to that commit (`<base>...<headSha>`): the PR's diff
 * against its merge base, provably that head's, never a newer one's that came between two
 * reads (the PR's file listing names no commit). Kept in `cache` per head. Null when it can't be
 * told: GitHub doesn't know the commit (404, 422), lists 300 files or more, or sends a file
 * with neither a patch nor a blob sha; any other error is thrown, so the verify step reads the
 * PR again later.
 */
export async function diffKeyAt(
  github: GithubService,
  projectId: string,
  baseBranch: string,
  headSha: string,
  cache: Map<string, string | null>,
): Promise<string | null> {
  const { owner, repo } = github.githubRepo(projectId);
  const key = `${owner}/${repo}@${headSha}:${baseBranch}`;
  const hit = cache.get(key);
  if (hit !== undefined) return hit;
  let listed: Array<{
    filename: string;
    previous_filename?: string;
    status: string;
    patch?: string;
    sha?: string | null;
  }>;
  try {
    listed = await github.client.run(
      async (o) =>
        (
          await o.rest.repos.compareCommitsWithBasehead({
            owner,
            repo,
            basehead: `${baseBranch}...${headSha}`,
            per_page: 1,
          })
        ).data.files ?? [],
    );
  } catch (error) {
    const code = error instanceof ServiceError ? error.code : null;
    if (code !== "github_not_found" && code !== "github_validation") throw error;
    return null;
  }
  const files = listed.map((f) => ({
    path: f.filename,
    ...(f.previous_filename ? { previousPath: f.previous_filename } : {}),
    status: f.status,
    patch: f.patch ?? null,
    sha: f.sha ?? null,
  }));
  const value = listed.length >= COMPARE_FILE_LIMIT ? null : prDiffKey(files, files.length);
  cache.set(key, value);
  while (cache.size > DIFF_KEYS_KEPT) {
    const oldest = cache.keys().next().value;
    if (oldest === undefined) break;
    cache.delete(oldest);
  }
  return value;
}

/**
 * Merge the default branch into the PR's branch on GitHub (`update-branch`). GitHub refuses
 * (422) when the head is no longer `expectedHeadSha` or the merge would conflict.
 */
export async function updateBranch(
  github: GithubService,
  projectId: string,
  number: number,
  expectedHeadSha: string,
): Promise<void> {
  const { owner, repo } = github.githubRepo(projectId);
  await github.client.run((o) =>
    o.rest.pulls.updateBranch({
      owner,
      repo,
      pull_number: number,
      expected_head_sha: expectedHeadSha,
    }),
  );
  github.sync.soon(projectId);
}

/** Comment on a pull request, then close it. */
export async function closePr(
  github: GithubService,
  projectId: string,
  number: number,
  comment: string,
): Promise<void> {
  const { owner, repo } = github.githubRepo(projectId);
  await github.commentOnIssue(projectId, number, comment);
  await github.client.run((o) =>
    o.rest.pulls.update({ owner, repo, pull_number: number, state: "closed" }),
  );
  github.sync.soon(projectId);
}

/**
 * Whether CI can run on the repository: GitHub Actions are enabled and at least one workflow is
 * active. Null when GitHub doesn't say (no permission to read the settings, a network error).
 */
export async function actionsAvailable(
  github: GithubService,
  projectId: string,
  log?: (message: string) => void,
): Promise<boolean | null> {
  const { owner, repo } = github.githubRepo(projectId);
  try {
    return await github.client.run(async (o) => {
      const permissions = await o.rest.actions.getGithubActionsPermissionsRepository({
        owner,
        repo,
      });
      if (!permissions.data.enabled) return false;
      const workflows = await o.rest.actions.listRepoWorkflows({ owner, repo, per_page: 100 });
      return workflows.data.workflows.some((w) => w.state === "active");
    });
  } catch (error) {
    log?.(`factory: reading the Actions settings: ${errorMessage(error)}`);
    return null;
  }
}
