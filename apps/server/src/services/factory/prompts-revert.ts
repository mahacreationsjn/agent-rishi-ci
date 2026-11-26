/** Briefs about automatic reverts (§10.1, Merge): writing one, and the work's way back after it. */

/** An agent writes the revert when the API cannot (main moved on after the merge). */
export function revertPrompt(opts: { sha: string; prNumber: number; title: string }): string {
  return [
    `CI on the default branch failed after pull request #${opts.prNumber} ("${opts.title}") was merged as ${opts.sha}.`,
    `Revert that commit in this worktree (\`git revert --no-edit ${opts.sha}\`), resolve conflicts conservatively, run the tests, and open a pull request titled \`Revert "${opts.title}"\` with \`create_pull_request\`. Its description says what it reverts and has a \`## Test results\` section saying that CI on the pull request is the evidence (plus what you ran). Do nothing else. Then call \`finish\`.`,
  ].join("\n");
}

/**
 * The revise round after a revert: the builder's merged PR broke CI on the default branch, the
 * revert merged and the branch is green again. The builder brings its change back on top of it
 * with the failure fixed, in a new PR (the old one is merged).
 */
export function revertedPrompt(opts: {
  branch: string;
  prNumber: number;
  mergeSha: string;
  /** Checks that failed on the merge commit; empty when GitHub didn't say. */
  failed: string[];
  revertPr: number | null;
  /** The revert's own merge commit on the default branch, when known. */
  revertSha: string | null;
}): string {
  const { branch, prNumber, mergeSha } = opts;
  const reverted = opts.revertPr ? ` in #${opts.revertPr}` : "";
  const failed = opts.failed.length > 0 ? opts.failed.join(", ") : "see the commit's checks";
  const restore = opts.revertSha
    ? `bring your change back with \`git revert --no-edit ${opts.revertSha}\` (it reverts the revert)`
    : `bring your change back (\`git cherry-pick ${mergeSha}\`)`;
  return [
    `**Revise (after a revert)**: your pull request #${prNumber} merged as ${mergeSha}, and CI on \`${branch}\` failed on that commit, so the factory reverted it${reverted}. \`${branch}\` is green again.`,
    `- Failed on ${mergeSha.slice(0, 7)}: ${failed}. Read the logs with \`gh run list --commit ${mergeSha}\` and \`gh run view <run id> --log-failed\`.`,
    "",
    `Start a new branch from the latest \`origin/${branch}\` (\`git fetch origin\`, then \`git switch -c <new branch> origin/${branch}\`), ${restore}, and fix what broke CI. Run the tests, commit, and open a new pull request with \`create_pull_request\` (#${prNumber} is merged, so it can't be reused), with a \`## Test results\` section and fresh test output attached with \`attach_evidence\`. Then call \`finish\`.`,
  ].join("\n");
}
