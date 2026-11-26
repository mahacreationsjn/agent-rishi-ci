import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { ClaudePolicy } from "../src/claude/permissions";
import { levelAllows } from "../src/codex/policy";
import { classifyCommand, type RiskContext } from "../src/policy/risk";
import { workdirRisk } from "../src/policy/workdir";

/**
 * Commands that change something in the folder they run in, without naming a path (#614): after a
 * `cd` (or `pushd`, `Set-Location`) outside the worktree, or with a program's own folder option
 * (`git -C`, `make -C`, `npm --prefix`, ...), they ask at Auto and Full. Reads never do, and the
 * worktree, its subfolders, temp folders and extra roots work as before.
 */

const posix: RiskContext = {
  cwd: "/work/repo",
  platform: "linux",
  home: "/home/me",
  tempRoots: ["/tmp"],
  shell: "posix",
};
const win: RiskContext = {
  cwd: "C:\\work\\repo",
  platform: "win32",
  home: "C:\\Users\\me",
  extraRoots: ["D:\\shared"],
  tempRoots: ["C:\\Users\\me\\AppData\\Local\\Temp"],
};
const ps: RiskContext = { ...win, shell: "powershell" };

/** Real folders, for `git rev-parse --show-toplevel`, which is found on disk. */
const made = mkdtempSync(join(tmpdir(), "agent-rishi-run-folder-"));
afterAll(() => rmSync(made, { recursive: true, force: true }));

const action = (command: string, ctx: RiskContext = posix) => {
  const r = classifyCommand(command, ctx);
  return r.risky ? r.action : null;
};

/** True when the command asks at both Auto and Full. */
const asksAtAutoAndFull = (command: string, ctx: RiskContext = posix) => {
  const risk = classifyCommand(command, ctx);
  return !levelAllows("auto", risk) && !levelAllows("full", risk);
};

describe("commands run outside the worktree (#614)", () => {
  it("asks for the cases in the issue at Auto and Full", () => {
    for (const cmd of [
      "cd /other && git reset --hard",
      "git -C /other clean -fdx",
      "make -C /other clean",
      "touch /other/x",
      "mkdir /other/x",
      "mkdir -p /other/x",
      "mkdir -pv /other/x",
      "touch -c /other/x",
    ]) {
      expect(asksAtAutoAndFull(cmd), cmd).toBe(true);
      expect(action(cmd), cmd).toBe("outside_worktree");
    }
    expect(classifyCommand("cd /other && git reset --hard", posix)).toMatchObject({
      reason: "Runs in /other, outside the worktree",
    });
    for (const level of ["auto", "full"] as const) {
      const policy = new ClaudePolicy(level, posix);
      expect(policy.gate("Bash", { command: "git -C /other clean -fdx" }).ask, level).toBe(true);
    }
  });

  it("reads each program's own folder options", () => {
    for (const cmd of [
      "npm --prefix /other install",
      "npm install --prefix=/other",
      "npm -C /other run build",
      "npx --prefix /other some-tool",
      "pnpm -C /other install",
      "pnpm --dir=/other install",
      "pnpm --dir /other add x",
      "yarn --cwd /other add x",
      "bun --cwd=/other install",
      "make --directory=/other clean",
      "make --directory /other",
      "make -sC /other",
      "make -C/other",
      "make -j4 clean -C /other",
      "git -C /work -C other reset --hard",
      "git --work-tree=/other --git-dir=/other/.git checkout .",
      "GIT_DIR=/other/.git GIT_WORK_TREE=/other git reset --hard",
      "env -C /other make clean",
      "env --chdir=/other git reset --hard",
      "env -S '-C /other git reset --hard'",
      "go -C /other generate ./...",
      "ninja -C /other",
      "tar -xf a.tar -C /other",
      "tar -xzf a.tgz --directory=/other",
      // Through a wrapper the classifier doesn't know.
      "timeout 60 git -C /other reset --hard",
      "nice make -C /other",
      // A folder only known when it runs.
      "ls | xargs -I{} git -C {} reset --hard",
      "git -C $REPO clean -fdx",
    ]) {
      expect(action(cmd), cmd).toBe("outside_worktree");
    }
  });

  it("follows the folder through ;, ||, subshells, substitutions, pushd and inline scripts", () => {
    for (const cmd of [
      "cd /other; git reset --hard",
      "cd /other\ngit reset --hard",
      "cd /other || git reset --hard",
      'cd "/other" && git reset --hard',
      "cd /work/repo/../other && git reset --hard",
      "cd .. && git clean -fdx",
      "cd && make clean",
      "cd ~ && make clean",
      "cd $HOME/other && make",
      "(cd /other && git reset --hard)",
      'echo "$(cd /other && git reset --hard)"',
      "pushd /other && git reset --hard && popd",
      "cd /other && pushd /work/repo && popd && git reset --hard",
      'bash -c "cd /other && git reset --hard"',
      "sh -c 'git -C /other clean -fdx'",
      // The script runs where env moved it, with the repository it was handed.
      "env -C /other bash -c 'make clean'",
      "GIT_DIR=/other/.git bash -c 'git reset --hard'",
      "cd /other && sudo make install",
      "builtin cd /other && git reset --hard",
      "command cd /other && git reset --hard",
      // A force push in another repository asks at Full too.
      "cd /other && git push --force",
    ]) {
      expect(asksAtAutoAndFull(cmd), cmd).toBe(true);
    }
    // A cd inside a subshell doesn't leak out.
    expect(action("(cd /other); git reset --hard")).toBeNull();
    // Back in the worktree, the outside folder no longer counts.
    expect(action("cd /other && cd /work/repo && make")).toBeNull();
    expect(action("pushd /other && popd && git reset --hard")).toBeNull();
  });

  it("leaves commands in the worktree, its subfolders, temp folders and extra roots alone", () => {
    for (const cmd of [
      "git reset --hard",
      "git clean -fdx",
      "make clean",
      "cd src && git reset --hard",
      "cd apps/web && pnpm build && cd ../.. && pnpm test",
      "cd /work/repo/apps/web && npm install",
      "git -C packages/x clean -fdx",
      "make -C build clean",
      "npm --prefix apps/web run build",
      "pnpm -C apps/web add zod",
      "touch src/x.ts",
      "mkdir -p dist/assets",
      "mkdir -p /tmp/scratch && cd /tmp/scratch && git init && npm init -y",
      "cd /tmp && git clone https://example.com/x.git",
      'mkdir -p "$TMPDIR"',
      "cd $TMPDIR/build && make",
      "tar -xzf a.tgz -C /tmp/x",
      "env -C src make",
      "env -C src bash -c 'make clean'",
    ]) {
      expect(action(cmd), cmd).toBeNull();
    }
  });

  it("never asks for a command that only reads, wherever it runs", () => {
    for (const cmd of [
      "cd /other && git log --oneline -5",
      "git -C /other status",
      "git -C /other diff HEAD~1 | head -50",
      "cd /other && ls -la && cat README.md",
      "cd /other && rg TODO src | wc -l",
      "pushd /other && git status && popd",
      "cd $SOMEWHERE && ls && git log -1",
      "cd /other && cd /somewhere/else",
      "cd /other && X=1",
    ]) {
      expect(action(cmd), cmd).toBeNull();
    }
  });

  it("counts a folder it can't know before the command runs as outside", () => {
    for (const cmd of [
      "cd $UNKNOWN && make",
      'cd "$(git rev-parse --show-toplevel)/.." && make',
      "cd `dirname $0` && make",
      "cd - && git reset --hard",
      "cd ~root && make",
      "cd {/other,} && git reset --hard",
      "cd .? && git clean -fdx",
      "cd ..* && git clean -fdx",
      // Relative moves from an unknown folder stay unknown, `..` included.
      "cd $X && cd src && make",
      "cd $X/.. && make",
      "cd $X && cd ../../work/repo && make",
      // And so do the paths that resolve from it.
      "cd $X && echo hi > out.txt",
      "cd $X && rm -rf build",
      // zsh's `cd old new` puts `new` for `old` in the current folder.
      "cd repo other && git reset --hard",
      "pushd /other && pushd /work/repo && pushd +1 && git reset --hard",
      // CDPATH sends `cd other` to any folder it lists.
      "CDPATH=/ cd other && git reset --hard",
      "export CDPATH=/; cd other; git clean -fdx",
    ]) {
      expect(asksAtAutoAndFull(cmd), cmd).toBe(true);
    }
    expect(classifyCommand("cd $UNKNOWN && make", posix)).toMatchObject({
      action: "outside_worktree",
      reason: "Runs in a folder only known when it runs, which may be outside the worktree",
    });
    // A cd to a known folder ends it.
    expect(action("cd $UNKNOWN && cd /work/repo && make")).toBeNull();
    expect(action("cd $X && cd /tmp/x && make")).toBeNull();
    expect(action("export CDPATH=/; cd ./src && make")).toBeNull();
    expect(action("cd -P src && make")).toBeNull();
    expect(action("pushd -n /other && make")).toBeNull();
  });

  it("follows find -execdir, folders xargs supplies, core.worktree and drive switches", () => {
    for (const [cmd, ctx] of [
      // `-execdir` runs in the folder holding each match: `/other` for `/other/x` itself.
      ["find /other/x -execdir make clean \\;", posix],
      ["find $X -okdir git reset --hard \\;", posix],
      // The folder comes from xargs' input.
      ["echo /other | xargs git -C", posix],
      ["echo /other | xargs make --directory", posix],
      ["git -c core.worktree=/other reset --hard", posix],
      // `D:` moves to wherever the shell last stood on that drive.
      ["D:; git clean -fdx", ps],
      ["D: && git clean -fdx", win],
    ] as const) {
      expect(asksAtAutoAndFull(cmd, ctx), cmd).toBe(true);
    }
    for (const [cmd, ctx] of [
      ["find . -name '*.o' -execdir rm {} +", posix],
      ["find src -name '*.o' -execdir rm {} +", posix],
      ["git -c core.autocrlf=false reset --hard", posix],
      ["C:; git clean -fdx", ps],
    ] as const) {
      expect(action(cmd, ctx), cmd).toBeNull();
    }
  });

  it("finds the folder `git rev-parse --show-toplevel` prints", () => {
    const repo = join(made, "repo");
    const other = join(made, "other");
    const broken = join(repo, "broken");
    mkdirSync(join(repo, ".git"), { recursive: true });
    mkdirSync(join(other, ".git"), { recursive: true });
    mkdirSync(broken);
    // A `.git` file that points nowhere: git fails, and `cd` with no folder goes home.
    writeFileSync(join(broken, ".git"), "nothing here");
    // No temp roots, so only the worktree makes these folders writable.
    const ctx: RiskContext = { cwd: repo, dir: join(repo, "apps", "web"), tempRoots: [] };
    for (const cmd of [
      "cd $(git rev-parse --show-toplevel) && pnpm test",
      'cd "$(git rev-parse --show-toplevel)/packages/x" && pnpm build',
      "cd `git rev-parse --show-toplevel` && make clean",
    ]) {
      expect(action(cmd, ctx), cmd).toBeNull();
    }
    for (const cmd of [
      'cd "$(git rev-parse --show-toplevel)/.." && make clean',
      `cd ${other} && cd $(git rev-parse --show-toplevel) && make clean`,
      `cd ${broken} && cd $(git rev-parse --show-toplevel) && make clean`,
      "cd $X && cd $(git rev-parse --show-toplevel) && make clean",
      "export GIT_WORK_TREE=/x; cd $(git rev-parse --show-toplevel) && make clean",
      // `git` may then print any folder (#663).
      "git() { echo /other; }; cd $(git rev-parse --show-toplevel) && make clean",
      "function git { echo /other; }; cd $(git rev-parse --show-toplevel) && make clean",
      "PATH=/tmp/bin:$PATH; cd $(git rev-parse --show-toplevel) && make clean",
      "alias git=/tmp/bin/git\ncd $(git rev-parse --show-toplevel) && make clean",
    ]) {
      expect(action(cmd, ctx), cmd).toBe("outside_worktree");
    }
  });

  it("judges a folder like the provider's working directory does (workdirRisk)", () => {
    const home = "/home/me/.agent-rishi";
    const ctx: RiskContext = { ...posix, agentRishiHome: home };
    // Agent Rishi's home may be caught by another check first, with its own reason.
    const verdict = (r: ReturnType<typeof classifyCommand>) =>
      r.risky
        ? { action: r.action, agentRishi: r.agentRishi, reason: r.agentRishi ? "" : r.reason }
        : r;
    for (const dir of ["/other", "/tmp", "/tmp/x", "/work/repo/src", home, `${home}/wt/p/b`]) {
      const asProvider = verdict(workdirRisk(["make clean"], dir, ctx));
      expect(verdict(classifyCommand(`cd ${dir} && make clean`, ctx)), dir).toEqual(asProvider);
      expect(verdict(classifyCommand("make clean", { ...ctx, dir })), dir).toEqual(asProvider);
    }
  });
});

describe("Windows, Git Bash, PowerShell and cmd", () => {
  it("asks outside the worktree in every form", () => {
    for (const [cmd, ctx] of [
      ["cd C:\\other && git reset --hard", win],
      ["cd /c/other && git reset --hard", { ...win, shell: "posix" }],
      ["git -C /c/other clean -fdx", { ...win, shell: "posix" }],
      ["git -C C:\\other clean -fdx", ps],
      ["Set-Location C:\\other; git reset --hard", ps],
      ["Set-Location -Path C:\\other; git reset --hard", ps],
      ["sl C:\\other; make clean", ps],
      ["chdir C:\\other & git reset --hard", win],
      ["Push-Location C:\\other; git reset --hard; Pop-Location", ps],
      ["cd /d C:\\other && git reset --hard", win],
      ["Set-Location $env:APPDATA; npm install", ps],
      ["Set-Location (Get-Item ..).FullName; git clean -fdx", ps],
      ["cd %APPDATA% && npm install", win],
      ['pwsh -Command "Set-Location C:\\other; git reset --hard"', ps],
      ['cmd /c "cd /d C:\\other && git reset --hard"', win],
      ["Start-Process git -ArgumentList 'reset','--hard' -WorkingDirectory C:\\other", ps],
      ["New-Item -ItemType Directory C:\\other\\x", ps],
      ["md C:\\other\\x", win],
      ["touch /c/other/x", { ...win, shell: "posix" }],
    ] as const) {
      expect(asksAtAutoAndFull(cmd, ctx), cmd).toBe(true);
    }
  });

  it("leaves the worktree, temp and extra roots alone", () => {
    for (const [cmd, ctx] of [
      ["cd C:\\work\\repo\\src && git reset --hard", win],
      ["cd /c/work/repo/src && make", { ...win, shell: "posix" }],
      ["cd /d C:\\work\\repo\\src && make", win],
      ["Set-Location $env:TEMP\\x; npm init -y", ps],
      ["cd /tmp/x && make", { ...win, shell: "posix" }],
      ["cd D:\\shared\\lib && make", win],
      ["git -C D:\\shared\\lib clean -fdx", ps],
      ["New-Item -ItemType Directory -Path src\\x -Force", ps],
      ["mkdir $env:TEMP\\x", ps],
      ["Set-Location C:\\other; git status; Get-ChildItem", ps],
      ["Set-Location C:\\work\\repo\\src -ErrorAction Stop; npm install", ps],
      ["cd C:\\other && git log -1 && dir", win],
    ] as const) {
      expect(action(cmd, ctx), cmd).toBeNull();
    }
  });
});

describe("Agent Rishi's own home", () => {
  const home = "/home/me/.agent-rishi";
  const own: RiskContext = { ...posix, cwd: `${home}/wt/p/abc`, agentRishiHome: home };

  it("asks at every level for a command run there, outside the session's own worktree", () => {
    for (const cmd of [
      "cd ~/.agent-rishi && git init",
      `cd ${home}/wt/p/other && git reset --hard`,
      "cd .. && git clean -fdx",
      `git -C ${home}/wt/p/other clean -fdx`,
      // An ordinary risk earlier in the command doesn't hide it.
      "cat .env; cd ~/.agent-rishi && npm init -y",
    ]) {
      const risk = classifyCommand(cmd, own);
      expect(risk, cmd).toMatchObject({ risky: true, agentRishi: true });
      expect(levelAllows("full", risk), cmd).toBe(false);
    }
  });

  it("leaves the session's own worktree alone", () => {
    for (const cmd of [`cd ${home}/wt/p/abc/src && make`, "cd src && git reset --hard"]) {
      expect(classifyCommand(cmd, own), cmd).toEqual({ risky: false });
    }
  });
});
