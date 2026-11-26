import { describe, expect, it } from "vitest";
import { levelAllows } from "../src/codex/policy";
import { classifyCommand, type RiskContext } from "../src/policy/risk";

/**
 * Where the shell is, as a command names it (#663): `$(pwd)`, `$PWD`, `(Get-Location)` and cmd's
 * `%CD%` stand for that folder at the start of a path, so a `cd` there is no unknown folder and
 * `$(pwd)/../x` is beside the worktree. And a name of three or more dots (Go's `./...`) is a file
 * or folder in the worktree, not a climb out of it: worktrees live in Agent Rishi's home, where a path
 * outside them asks at every level.
 */

const posix: RiskContext = {
  cwd: "/home/me/.agent-rishi/wt/proj/abcd",
  platform: "linux",
  home: "/home/me",
  tempRoots: ["/tmp"],
  agentRishiHome: "/home/me/.agent-rishi",
  shell: "posix",
  env: {},
};
const win: RiskContext = {
  cwd: "C:\\Users\\me\\.agent-rishi\\wt\\proj\\abcd",
  platform: "win32",
  home: "C:\\Users\\me",
  tempRoots: ["C:\\Users\\me\\AppData\\Local\\Temp"],
  agentRishiHome: "C:\\Users\\me\\.agent-rishi",
  env: {},
};
const gitBash: RiskContext = { ...win, shell: "posix" };
const ps: RiskContext = { ...win, shell: "powershell" };
const unknown: RiskContext = { ...win, shell: "auto" };

const levels = (command: string, ctx: RiskContext) => {
  const risk = classifyCommand(command, ctx);
  return `${levelAllows("auto", risk) ? "-" : "auto"}/${levelAllows("full", risk) ? "-" : "full"}`;
};
const neverAsks = (commands: string[], ctx: RiskContext) => {
  for (const command of commands) expect(levels(command, ctx), command).toBe("-/-");
};
const asksAtBoth = (commands: string[], ctx: RiskContext) => {
  for (const command of commands) expect(levels(command, ctx), command).toBe("auto/full");
};

describe("where the shell is (#663)", () => {
  it("is a known folder for cd, in each shell's own forms", () => {
    const both = [
      'cd "$(pwd)" && pnpm test',
      'cd "$(pwd)/apps/web" && pnpm build',
      'cd "$PWD/apps/web" && pnpm build',
      `cd "$\{PWD}/apps/web" && make clean`,
      'ROOT=$(pwd); cd "$ROOT/apps/web" && pnpm build',
      'here=$(pwd); cd apps/web && pnpm build && cd "$here" && git status',
    ];
    neverAsks(
      [...both, "cd `pwd`/apps && make clean", 'cd "$(pwd -P)/apps" && git clean -fdx'],
      posix,
    );
    neverAsks(both, gitBash);
    neverAsks(
      [
        "Set-Location (Get-Location); pnpm test",
        "Set-Location (Get-Location).Path; git clean -fdx",
        "Set-Location $(pwd); pnpm install",
        'Set-Location "$PWD\\apps\\web"; pnpm build',
        "Set-Location $pwd; git clean -fdx",
        "cd (gl); pnpm test",
      ],
      ps,
    );
    neverAsks(
      ["Set-Location (Get-Location); pnpm test", "cd %CD%\\apps && make clean", 'cd "$(pwd)"'],
      unknown,
    );
  });

  it("is that folder at the start of a written path", () => {
    neverAsks(
      [
        'rm -rf "$(pwd)/dist"',
        'd=$(pwd)/dist; rm -rf "$d"',
        'ROOT=$(pwd); rm -rf "$ROOT/dist"',
        'echo hi > "$PWD/out.txt"',
      ],
      posix,
    );
    neverAsks(
      ['Set-Content -Path "$PWD\\out.txt" -Value x', "Remove-Item -Recurse $PWD\\dist"],
      ps,
    );
    // Beside the worktree is in Agent Rishi's home: every level asks, with or without the folder named.
    for (const ctx of [posix, gitBash]) {
      asksAtBoth(
        [
          'rm -rf "$(pwd)/../x"',
          'cp a "$(pwd)/../x"',
          'echo hi > "$(pwd)/../x.txt"',
          'rm -rf "$PWD/../x"',
          'd=$(pwd)/..; rm -rf "$d/x"',
          'cd "$(pwd)/.." && make clean',
        ],
        ctx,
      );
    }
    asksAtBoth(['Remove-Item -Recurse "$PWD\\..\\x"'], ps);
  });

  it("is only known when followed by a separator, in the shell's own forms", () => {
    // `$PWD../x` and `$(pwd)x` are beside the worktree; a POSIX shell's `$pwd` is empty.
    asksAtBoth(
      [
        'rm -rf "$(pwd)../x"',
        'mkdir "$(pwd).."',
        'rm -rf "$PWD../x"',
        `rm -rf "$\{PWD}../x"`,
        'd=$(pwd); rm -rf "$d../x"',
        'd=$(pwd)..; rm -rf "$d/x"',
        'cd "$PWD../x" && make clean',
        'cd "$(pwd)x" && make clean',
        'rm -rf "$pwd/etc"',
        'rm -rf "$(pwd)\\x"',
        'mkdir -p "..$(pwd)"',
      ],
      posix,
    );
    asksAtBoth(
      ['Remove-Item -Recurse "$PWD..\\x"', 'Set-Location "$PWD..\\x"; git clean -fdx'],
      ps,
    );
    // A POSIX shell runs `Get-Location` as a missing command: `"$(Get-Location)/x"` is `/x`.
    asksAtBoth(['rm -rf "$(Get-Location)/x"', "cd $(gl) && make clean"], unknown);
  });

  it("is not known once the command line may change what pwd, Get-Location or git print", () => {
    asksAtBoth(
      [
        'pwd() { echo /etc; }; rm -rf "$(pwd)/x"',
        'pwd() { echo /etc; }; d=$(pwd); rm -rf "$d/x"',
        "eval 'pwd() { echo /etc; }'; rm -rf \"$(pwd)/x\"",
        "shopt -s expand_aliases\nalias pwd='echo /etc'\nrm -rf \"$(pwd)/x\"",
        'source ./defs.sh && rm -rf "$(pwd)/x"',
        'function pwd { echo /etc; }; cd "$(pwd)" && make clean',
      ],
      posix,
    );
    asksAtBoth(
      [
        "function Get-Location { 'C:\\other' }; Set-Location (Get-Location); git clean -fdx",
        "Set-Alias -Name gl -Value x -Force; Set-Location (gl); git clean -fdx",
        "Set-Item function:pwd { 'C:\\other' }; Set-Location (pwd); git clean -fdx",
      ],
      ps,
    );
    // What only looks like it doesn't count.
    neverAsks(
      ['corepack enable && cd "$(pwd)" && pnpm install', "git config alias.st status"],
      posix,
    );
  });

  it("stays on a PowerShell drive that isn't the filesystem", () => {
    asksAtBoth(
      [
        "Set-Location HKCU:\\Software; Set-Location (Get-Location); Remove-Item -Recurse x",
        'Set-Location HKCU:\\Software; Remove-Item -Recurse "$PWD\\x"',
      ],
      ps,
    );
  });
});

describe("names of three or more dots (#663)", () => {
  it("are files and folders in the worktree, not Agent Rishi's home", () => {
    for (const ctx of [posix, gitBash, unknown]) {
      neverAsks(
        [
          "go test ./...",
          "go vet ./... && go build ./...",
          "ls ...",
          "rm -rf ./...",
          `node -e "process.stdout.write('...')"`,
          "python -c \"open('...', 'w').write('x')\"",
        ],
        ctx,
      );
    }
  });

  it("still leave the worktree with `..`, and with other names starting with `..`", () => {
    for (const ctx of [posix, gitBash]) {
      asksAtBoth(["rm -rf ../x", "ls ..", "rm -rf ..x", "mkdir -p ..$HOME", "cat ../other/x"], ctx);
    }
    expect(classifyCommand("go test ../...", posix)).toMatchObject({ agentRishi: true });
  });
});
