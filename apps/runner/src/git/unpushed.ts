import type { RunnerCommandResult } from "@agent-rishi/contracts";
import { gitOk, gitText } from "./exec";
import { status } from "./ops";

type UnpushedBranch = RunnerCommandResult<"git.unpushed">["branches"][number];

/** `git rev-list --count …`, as a number. */
async function count(cwd: string, args: string[]): Promise<number> {
  return Number(await gitText(cwd, ["rev-list", "--count", ...args])) || 0;
}

/**
 * What exists only in this clone (`git.unpushed`, #337), so a container's clone is never deleted
 * with work in it by accident:
 * - files with uncommitted changes, untracked ones included;
 * - per local branch, the commits its upstream doesn't contain; for a branch that was never
 *   pushed, or whose upstream is gone, the commits no remote-tracking branch has;
 * - on a detached HEAD, the commits no branch or remote-tracking branch has;
 * - the number of stashes.
 * It reads only what this clone knows about its remotes; it doesn't fetch.
 */
export async function unpushed(cwd: string): Promise<RunnerCommandResult<"git.unpushed">> {
  const { branch: current, files } = await status(cwd);
  const branches: UnpushedBranch[] = [];
  const refs = await gitText(cwd, [
    "for-each-ref",
    "--format=%(refname)%00%(upstream)",
    "refs/heads",
  ]);
  for (const line of refs.split("\n")) {
    if (!line) continue;
    const [ref = "", upstream = ""] = line.split("\0");
    const tracked =
      upstream !== "" &&
      (await gitOk(cwd, ["rev-parse", "--verify", "--quiet", `${upstream}^{commit}`]));
    const commits = await count(cwd, tracked ? [ref, `^${upstream}`] : [ref, "--not", "--remotes"]);
    if (commits > 0) branches.push({ name: ref.replace(/^refs\/heads\//, ""), commits });
  }
  if (current === null && (await gitOk(cwd, ["rev-parse", "--verify", "--quiet", "HEAD"]))) {
    const commits = await count(cwd, ["HEAD", "--not", "--branches", "--remotes"]);
    if (commits > 0) branches.push({ name: "HEAD", commits });
  }
  const stashes = (await gitText(cwd, ["stash", "list", "--format=%H"]))
    .split("\n")
    .filter(Boolean).length;
  return { current, uncommitted: files.length, branches, stashes };
}
