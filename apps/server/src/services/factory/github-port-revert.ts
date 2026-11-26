import type { GitHubPrRef } from "@agent-rishi/contracts";
import type { GithubService } from "../github/github-service";

/**
 * The GitHub calls behind the factory's automatic reverts (§10.1, Merge): opening the revert of
 * a squash merge whose CI on the default branch failed, and telling by tree comparison whether a
 * revert PR is exactly the inverse of that merge.
 */

/** The `## Test results` section of an automatic revert PR: its own CI run is the evidence. */
export function revertTestResults(branch: string, prNumber: number): string {
  return `## Test results\n\nCI on this pull request is the evidence: the revert restores \`${branch}\` to its state before #${prNumber}, which CI passed then. The factory merges it only once that CI run is green.`;
}

/**
 * Open a PR reverting a squash merge when it is still the head of the default branch: one commit
 * on top of the merge whose tree is the merge's parent's. Null when main moved on (an agent then
 * writes the revert) or the commit isn't a squash merge.
 */
export async function revertMerge(
  github: GithubService,
  projectId: string,
  merge: { sha: string; prNumber: number; title: string },
): Promise<GitHubPrRef | null> {
  const { owner, repo: name, defaultBranch } = github.githubRepo(projectId);
  return github.client.run(async (o) => {
    const head = (await o.rest.git.getRef({ owner, repo: name, ref: `heads/${defaultBranch}` }))
      .data.object.sha;
    if (head !== merge.sha) return null;
    const commit = (await o.rest.git.getCommit({ owner, repo: name, commit_sha: merge.sha })).data;
    const parent = commit.parents[0]?.sha;
    if (!parent || commit.parents.length !== 1) return null;
    const parentTree = (await o.rest.git.getCommit({ owner, repo: name, commit_sha: parent })).data
      .tree.sha;
    const revert = await o.rest.git.createCommit({
      owner,
      repo: name,
      message: `Revert "${merge.title}" (#${merge.prNumber})\n\nAutomatic revert by the Agent Rishi factory: CI on ${defaultBranch} failed after the merge.`,
      tree: parentTree,
      parents: [merge.sha],
    });
    const branch = `agent-rishi/revert-${merge.prNumber}-${merge.sha.slice(0, 7)}`;
    await o.rest.git.createRef({
      owner,
      repo: name,
      ref: `refs/heads/${branch}`,
      sha: revert.data.sha,
    });
    const pr = await o.rest.pulls.create({
      owner,
      repo: name,
      head: branch,
      base: defaultBranch,
      title: `Revert "${merge.title}"`,
      body: `Reverts #${merge.prNumber} (${merge.sha}).\n\nCI on \`${defaultBranch}\` failed after the merge, so the Agent Rishi factory opened this revert and paused its loop. It merges first, once its own CI is green; the loop resumes when \`${defaultBranch}\` is green again.\n\n${revertTestResults(defaultBranch, merge.prNumber)}`,
    });
    github.sync.soon(projectId);
    return { number: pr.data.number, url: pr.data.html_url, state: "open", title: pr.data.title };
  });
}

/**
 * Whether head commit `headSha` is exactly the revert of squash merge `mergeSha`, by tree
 * comparison: its only parent is the merge, and its tree is the tree of the merge's parent. A
 * revert that had conflicts to resolve, sits on a later main, or changes anything else isn't.
 */
export async function revertMatches(
  github: GithubService,
  projectId: string,
  revert: { headSha: string; mergeSha: string },
): Promise<boolean> {
  const { owner, repo } = github.githubRepo(projectId);
  return github.client.run(async (o) => {
    const head = (await o.rest.git.getCommit({ owner, repo, commit_sha: revert.headSha })).data;
    if (head.parents.length !== 1 || head.parents[0]?.sha !== revert.mergeSha) return false;
    const merge = (await o.rest.git.getCommit({ owner, repo, commit_sha: revert.mergeSha })).data;
    const parent = merge.parents[0]?.sha;
    if (!parent || merge.parents.length !== 1) return false;
    const before = (await o.rest.git.getCommit({ owner, repo, commit_sha: parent })).data;
    return head.tree.sha === before.tree.sha;
  });
}
