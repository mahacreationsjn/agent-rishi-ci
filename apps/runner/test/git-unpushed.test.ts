import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { unpushed } from "../src/git/unpushed";
import { makeRepo, removeDir, sh, tempDir, write } from "./helpers";

/**
 * `git.unpushed` (#337): what exists only in a clone, asked before a container's clone is
 * deleted. Getting it wrong deletes work, so each way a commit can be left behind is covered.
 */

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0).reverse()) removeDir(dir);
});

/** A bare "remote" with one commit on main, and a clone of it with identity set. */
function cloneOfRemote(): string {
  const work = makeRepo({ "README.md": "# demo\n" });
  const bare = tempDir("agent-rishi-bare-");
  const parent = tempDir("agent-rishi-clone-");
  dirs.push(work, bare, parent);
  sh(bare, "init", "-q", "--bare", "-b", "main");
  sh(work, "push", "-q", bare, "main");
  // Set before checkout, so files stay as committed on Windows too.
  sh(parent, "clone", "-q", "-c", "core.autocrlf=false", bare, "clone");
  const clone = join(parent, "clone");
  sh(clone, "config", "user.name", "Test");
  sh(clone, "config", "user.email", "test@example.com");
  return clone;
}

function commit(cwd: string, file: string): void {
  write(cwd, file, `${file}\n`);
  sh(cwd, "add", "-A");
  sh(cwd, "commit", "-q", "-m", `add ${file}`);
}

const NOTHING = { uncommitted: 0, branches: [], stashes: 0 };

describe("git.unpushed", () => {
  it("finds nothing in a fresh clone, or on a new branch with no commits of its own", async () => {
    const clone = cloneOfRemote();
    expect(await unpushed(clone)).toEqual({ current: "main", ...NOTHING });
    sh(clone, "checkout", "-q", "-b", "agent-rishi/new");
    expect(await unpushed(clone)).toEqual({ current: "agent-rishi/new", ...NOTHING });
  });

  it("counts commits a branch's upstream lacks, and those no remote has on a branch never pushed", async () => {
    const clone = cloneOfRemote();
    commit(clone, "a.md");
    sh(clone, "checkout", "-q", "-b", "agent-rishi/fix");
    commit(clone, "b.md");
    commit(clone, "c.md");
    expect(await unpushed(clone)).toEqual({
      current: "agent-rishi/fix",
      ...NOTHING,
      branches: [
        // a.md is on both, and no remote has it.
        { name: "agent-rishi/fix", commits: 3 },
        { name: "main", commits: 1 },
      ],
    });

    sh(clone, "push", "-q", "-u", "origin", "agent-rishi/fix");
    // main's upstream still lacks a.md, though origin/agent-rishi/fix has it.
    expect((await unpushed(clone)).branches).toEqual([{ name: "main", commits: 1 }]);
    sh(clone, "push", "-q", "origin", "main");
    expect((await unpushed(clone)).branches).toEqual([]);
  });

  it("falls back to every remote branch when a branch's upstream is gone", async () => {
    const clone = cloneOfRemote();
    sh(clone, "checkout", "-q", "-b", "agent-rishi/merged");
    commit(clone, "a.md");
    sh(clone, "push", "-q", "-u", "origin", "agent-rishi/merged");
    commit(clone, "b.md");
    // The remote branch is deleted (merged and cleaned up) and pruned here.
    sh(clone, "push", "-q", "origin", "--delete", "agent-rishi/merged");
    expect((await unpushed(clone)).branches).toEqual([{ name: "agent-rishi/merged", commits: 2 }]);
  });

  it("counts commits on a detached HEAD that no branch holds", async () => {
    const clone = cloneOfRemote();
    sh(clone, "checkout", "-q", "--detach");
    commit(clone, "a.md");
    expect(await unpushed(clone)).toEqual({
      current: null,
      ...NOTHING,
      branches: [{ name: "HEAD", commits: 1 }],
    });
  });

  it("counts files with uncommitted changes, untracked ones included, and stashes", async () => {
    const clone = cloneOfRemote();
    write(clone, "README.md", "# changed\n");
    write(clone, "notes/new.md", "new\n");
    expect(await unpushed(clone)).toMatchObject({ uncommitted: 2, stashes: 0 });
    sh(clone, "stash", "push", "-q", "-u");
    write(clone, "README.md", "# changed again\n");
    sh(clone, "stash", "push", "-q");
    expect(await unpushed(clone)).toEqual({ current: "main", ...NOTHING, stashes: 2 });
  });

  it("reports a missing clone as cwd_missing", async () => {
    const parent = tempDir("agent-rishi-gone-");
    dirs.push(parent);
    await expect(unpushed(join(parent, "nope"))).rejects.toMatchObject({
      code: "cwd_missing",
    });
  });
});
