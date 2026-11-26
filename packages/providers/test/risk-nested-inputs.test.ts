import { describe, expect, it } from "vitest";
import { levelAllows } from "../src/codex/policy";
import { classifyCommand, type RiskContext } from "../src/policy/risk";

/**
 * Forms of the same commands one step removed: input a subshell or a block inherits, scripts and
 * targets the shell builds when it runs, PowerShell's other ways to name a command or its items,
 * and the options git, package runners and copies take.
 */

const posix: RiskContext = {
  cwd: "/work/repo",
  platform: "linux",
  home: "/home/me",
  tempRoots: ["/tmp"],
  shell: "posix",
  agentRishiHome: "/home/me/.agent-rishi",
};
const win = {
  cwd: "C:\\work\\repo",
  platform: "win32" as const,
  home: "C:\\Users\\me",
  tempRoots: ["C:\\Users\\me\\AppData\\Local\\Temp"],
  agentRishiHome: "C:\\Users\\me\\.agent-rishi",
};
const unknown: RiskContext = { ...win, shell: "auto" };
const ps: RiskContext = { ...win, shell: "powershell" };

const levels = (command: string, ctx: RiskContext = posix) => {
  const risk = classifyCommand(command, ctx);
  return `${levelAllows("auto", risk) ? "-" : "auto"}/${levelAllows("full", risk) ? "-" : "full"}`;
};
const asksAtBoth = (commands: string[], ctx: RiskContext = posix) => {
  for (const command of commands) expect(levels(command, ctx), command).toBe("auto/full");
};
const asksAtAuto = (commands: string[], ctx: RiskContext = posix) => {
  for (const command of commands) expect(levels(command, ctx), command).toBe("auto/-");
};
const neverAsks = (commands: string[], ctx: RiskContext = posix) => {
  for (const command of commands) expect(levels(command, ctx), command).toBe("-/-");
};
const lines = (...text: string[]) => text.join("\n");

/** `Remove-Item C:\other -Recurse`, as `-EncodedCommand` takes it. */
const ENCODED = Buffer.from("Remove-Item C:\\other -Recurse", "utf16le").toString("base64");

describe("input a shell inherits", () => {
  it("classifies the script a subshell, a block, a function or an inner shell reads", () => {
    asksAtBoth([
      "echo 'rm -rf /other' | (sh)",
      "echo 'rm -rf /other' | bash -c 'sh'",
      "f() { sh; }; echo 'rm -rf /other' | f",
      lines("(sh) <<EOF", "rm -rf /other", "EOF"),
      lines("{ sh; } <<EOF", "rm -rf /other", "EOF"),
      lines("f() { sh; }; f <<'EOF'", "rm -rf /other", "EOF"),
      // The outer shell takes the backslash out before the inner one reads the body.
      lines("bash <<EOF", "cat <<IN", "\\$(rm -rf /other)", "IN", "EOF"),
    ]);
    asksAtAuto(["cat script.sh | (sh)", "echo 'rm -rf /other' | tee >(sh)"]);
  });

  it("leaves a subshell that runs no script alone", () => {
    neverAsks(["echo hi | (cat)", "cat x.json | (cd packages/x && jq .)", "echo 'ls' | (sh)"]);
  });
});

describe("scripts and targets built when the command runs", () => {
  it("asks for a script the shell builds", () => {
    asksAtAuto(['bash <<< "$x"', 'sh -c "$x"', 'sh -c "$(cat x)"']);
    asksAtBoth(["x='rm -rf /other'; bash <<< \"$x\"", "x='rm -rf /other'; sh -c \"$x\""]);
  });

  it("splits an unquoted variable into words", () => {
    asksAtBoth(["x='rm -rf /other'; $x", 'o="-rf /other"; rm $o', 'x="rm -rf"; $x /other']);
    neverAsks(['x="ls -la"; $x', 'msg="delete /other --force"; git commit -m "$msg"']);
  });

  it("asks for a write or delete target a substitution names", () => {
    asksAtBoth([
      "rm -rf $(echo /other)",
      "rm -rf `cat list`",
      'rm -rf "$(dirname "$PWD")/x"',
      "echo hi > $(cat f)",
      'cp a "$(cat f)"',
    ]);
  });

  it("doesn't ask where the substitution's output is known, or for reads", () => {
    neverAsks([
      'rm -rf "$(pwd)/dist"',
      'rm -rf "$(git rev-parse --show-toplevel)/dist"',
      'd=$(pwd)/dist; rm -rf "$d"',
      'cp a "$(mktemp -d)/x"',
      'echo hi > "log-$(date +%F).txt"',
      "ls $(cat dirs)",
      "git add $(git diff --name-only)",
      'git commit -m "$(cat msg.txt)"',
      'bash -c "echo $HOME"',
    ]);
    neverAsks(
      [
        '$d = "$PWD\\dist"; Remove-Item $d -Recurse',
        'Get-ChildItem src | Move-Item -Destination { "dist\\$($_.Name)" }',
      ],
      ps,
    );
  });
});

describe("PowerShell's other forms", () => {
  it("reads a copy's /x as a path where cmd isn't the shell", () => {
    asksAtBoth(["move src /o", "copy src /o", "move src /other"], ps);
    asksAtBoth(["move src /o", "copy src /o"], unknown);
    neverAsks(
      ["copy a b /y", "move /y a b", "xcopy src dst /e /i", "robocopy src dst /e"],
      unknown,
    );
  });

  it("takes a piped delete's target from strings at the head of the pipe", () => {
    asksAtBoth(
      [
        "'C:\\other' | Remove-Item -Recurse",
        "'C:\\other' | % { Remove-Item $_ -Recurse }",
        "'src','C:\\other' | ForEach-Object { Remove-Item $_ }",
        "@('C:\\other') | % { Remove-Item $_ }",
        "function f { param($p) Remove-Item $p -Recurse }; f C:\\other",
      ],
      ps,
    );
    neverAsks(["'build','dist' | % { Remove-Item $_ -Recurse }", "'hi' | Set-Content out.txt"], ps);
  });

  it("reads a command however PowerShell is given it", () => {
    asksAtBoth(
      [
        'powershell /c "Remove-Item C:\\other"',
        'powershell -com "Remove-Item C:\\other"',
        'powershell -NoProfile -ExecutionPolicy Bypass "Remove-Item C:\\other"',
        `powershell /enc ${ENCODED}`,
        `powershell -EncodedCommand:${ENCODED}`,
        "[ IO.File ]:: Delete('C:\\other\\x')",
        "[IO.File]::ReadAllText('C:\\Users\\me\\.agent-rishi\\token')",
      ],
      ps,
    );
    asksAtAuto(["[IO.File]::ReadAllText('.env')"], ps);
    neverAsks(
      [
        "powershell -NoProfile -File scripts\\build.ps1",
        "powershell .\\build.ps1",
        "pwsh ./build.ps1",
        "[IO.File]::ReadAllText('package.json')",
      ],
      ps,
    );
  });
});

describe("options of git, package runners and copies", () => {
  it("classifies what they run or write", () => {
    asksAtBoth([
      "git rebase -x'rm -rf /other' HEAD~1",
      "git rebase -ix 'rm -rf /other' HEAD~1",
      "git -calias.x='!rm -rf /other' x",
      "git -c filter.x.clean='rm -rf /other' add .",
      "GIT_EDITOR='rm -rf /other' git commit",
      "GIT_SSH_COMMAND='rm -rf /other' git fetch",
      "npx --yes rimraf@5 /other",
      "xargs -I{} cp {} /other",
      "cp -t /other a",
      "mv --target-directory=/other a b",
    ]);
    asksAtBoth(["env r\\m -rf /c/other", "/usr/bin/r\\m -rf /c/other"], unknown);
  });

  it("leaves ordinary uses alone", () => {
    neverAsks([
      "GIT_EDITOR=true git rebase --continue",
      "GIT_SEQUENCE_EDITOR=: git rebase -i HEAD~2",
      "git -c core.pager=cat log -3",
      "git rebase -X theirs main",
      "npx prettier@3 --write src",
      "npx @biomejs/biome check --write .",
      "xargs -I{} cp {} dist/ < list",
      "cp -rt dist a b",
    ]);
  });
});
