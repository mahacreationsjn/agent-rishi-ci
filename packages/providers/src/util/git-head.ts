import { existsSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

/**
 * The root of the repository `dir` is in, as `git rev-parse --show-toplevel` prints it with no
 * `GIT_DIR` or `GIT_WORK_TREE` set: the nearest folder up from `dir` (itself included) holding a
 * `.git` folder or file. Undefined when there is none, or the `.git` file there points nowhere
 * (git then fails and prints nothing). Reads the disk only; never runs git.
 */
export function gitTopLevel(dir: string): string | undefined {
  for (let at = path.resolve(dir); ; at = path.dirname(at)) {
    const marker = path.join(at, ".git");
    if (existsSync(marker)) {
      try {
        if (statSync(marker).isDirectory()) return at;
        return /^gitdir:\s*\S/m.test(readFileSync(marker, "utf8")) ? at : undefined;
      } catch {
        return undefined;
      }
    }
    if (path.dirname(at) === at) return undefined;
  }
}

/**
 * The branch checked out in the repository at `dir` (its `.git` folder, or the `gitdir:` a
 * worktree's `.git` file points to), read straight from `HEAD`. Undefined when detached, when
 * `dir` is not a repository root, or on any error. Reads files only; never runs git.
 */
export function currentGitBranch(dir: string): string | undefined {
  try {
    const marker = path.join(dir, ".git");
    let gitDir = marker;
    if (statSync(marker).isFile()) {
      const pointer = /^gitdir:\s*(.+)$/m.exec(readFileSync(marker, "utf8"))?.[1]?.trim();
      if (!pointer) return undefined;
      gitDir = path.resolve(dir, pointer);
    }
    const head = readFileSync(path.join(gitDir, "HEAD"), "utf8").trim();
    return /^ref:\s*refs\/heads\/(.+)$/.exec(head)?.[1];
  } catch {
    return undefined;
  }
}
