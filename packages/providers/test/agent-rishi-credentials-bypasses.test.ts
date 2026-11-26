import type { AutonomyLevel } from "@agent-rishi/contracts";
import { describe, expect, it } from "vitest";
import { ClaudePolicy } from "../src/claude/permissions";
import { assessClaudeTool } from "../src/claude/tools";
import { commandRisk, levelAllows } from "../src/codex/policy";
import { OpenCodePolicy, type PermissionCall } from "../src/opencode/policy";
import { classifyCommand, classifyRead, classifyWrite, type RiskContext } from "../src/policy/risk";

/**
 * Ordinary command syntax that names Agent Rishi's own credential files (§11.2, §15) must not slip
 * past the guard: search options with attached values or in clusters (`grep -e. file`,
 * `-ne.`, `-fFILE`), PowerShell path lists (`Get-Content a,b`), and an Agent Rishi home whose
 * folder name has glob characters in it (`Agent Rishi [dev]`).
 */
const posix: RiskContext = {
  cwd: "/home/me/.agent-rishi/wt/repo/abc123",
  platform: "linux",
  home: "/home/me",
  tempRoots: ["/tmp"],
  agentRishiHome: "/home/me/.agent-rishi",
};
const win: RiskContext = {
  cwd: "C:\\Users\\me\\.agent-rishi\\wt\\repo\\abc123",
  platform: "win32",
  home: "C:\\Users\\me",
  tempRoots: ["C:\\Users\\me\\AppData\\Local\\Temp"],
  agentRishiHome: "C:\\Users\\me\\.agent-rishi",
};

const guarded = (command: string, ctx: RiskContext) => {
  const r = classifyCommand(command, ctx);
  return r.risky && r.agentRishi === true;
};
const action = (command: string, ctx: RiskContext) => {
  const r = classifyCommand(command, ctx);
  return r.risky ? r.action : null;
};

const FILES = ["install-token", "runner/runner.json", "remote-access.json"];

describe("search options with attached values or in clusters", () => {
  const posixReads = [
    // From the report.
    "grep -e. /home/me/.agent-rishi/install-token",
    "rg -e. /home/me/.agent-rishi/runner/runner.json",
    "grep -ne. /home/me/.agent-rishi/remote-access.json",
    "rg --hidden -g install-token -e. /home/me",
    // `-eVALUE` and clusters ending in `e`, direct paths.
    "grep -etoken ~/.agent-rishi/install-token",
    "egrep -ie. $AGENT_RISHI_HOME/runner/runner.json",
    "rg -ie. ~/.agent-rishi/remote-access.json",
    // An attached pattern file.
    "grep -fpatterns.txt /home/me/.agent-rishi/install-token",
    "grep -nfpatterns.txt ~/.agent-rishi/runner/runner.json",
    "rg -fpatterns.txt $AGENT_RISHI_HOME/remote-access.json",
    // Recursive, from a folder above them.
    "grep -re. /home/me",
    "grep -rne. ~/.agent-rishi",
    "grep -r -e. /home/me",
    "grep -Rfpatterns.txt ~",
    "rg -e. ~",
    "rg -ie. $AGENT_RISHI_HOME",
    // The pattern file is the credential.
    "grep -f/home/me/.agent-rishi/install-token README.md",
    "grep -nf$AGENT_RISHI_HOME/runner/runner.json README.md",
    // After `--` every word is an operand, even one starting with `-`.
    "grep -- -x ~/.agent-rishi/install-token",
    "grep -e. -- ~/.agent-rishi/remote-access.json",
  ];
  const gitBashReads = [
    "grep -e. C:\\Users\\me\\.agent-rishi\\install-token",
    "rg -e. /c/Users/me/.agent-rishi/runner/runner.json",
    "grep -ne. $AGENT_RISHI_HOME/remote-access.json",
    "grep -fpatterns.txt C:/Users/me/.agent-rishi/install-token",
    "rg --hidden -g install-token -e. C:\\Users\\me",
    "grep -re. /c/Users/me",
  ];

  it("reach the credential files on POSIX", () => {
    for (const cmd of posixReads) {
      expect(action(cmd, posix), cmd).toBe("secrets");
      expect(guarded(cmd, posix), cmd).toBe(true);
    }
  });

  it("leaves the options of tools whose -f takes no value as written", () => {
    // `ag -f` follows symlinks and `ack -f` lists files: `~` stays a root, not a pattern file.
    for (const cmd of ["ag token -if ~", "ack token -if ~"]) {
      expect(guarded(cmd, posix), cmd).toBe(true);
    }
  });

  it("reach the credential files from Git Bash on Windows", () => {
    for (const cmd of gitBashReads)
      expect(guarded(cmd, { ...win, shell: "posix" }), cmd).toBe(true);
  });

  it("ordinary searches in the project stay safe", () => {
    for (const cmd of [
      "grep -e. src",
      "grep -ne. README.md",
      "grep -rne. src",
      "grep -re. .",
      "grep -fpatterns.txt src/index.ts",
      "rg -e. src",
      "rg -ie. -g '*.ts'",
      // A project file that is merely named like a credential file.
      "grep -ne. install-token",
      "rg -e. runner/runner.json",
      // A pattern that only names a credential file searches other files for that text.
      "grep -e/home/me/.agent-rishi/install-token README.md",
      "grep -ne~/.agent-rishi/install-token docs",
      "grep -- ~/.agent-rishi/install-token README.md",
      // Clustered options with values (`-A3`, `-m1`) are not files.
      "grep -nA3 -m1 token src",
    ]) {
      expect(action(cmd, posix), cmd).toBeNull();
    }
  });
});

describe("PowerShell path lists", () => {
  const lists = [
    // From the report.
    "Get-Content -LiteralPath C:\\Users\\me\\.agent-rishi\\install-token,C:\\Users\\me\\.agent-rishi\\runner\\runner.json",
    "Select-String -Pattern . -Path C:\\Users\\me\\.agent-rishi\\install-token,C:\\Users\\me\\.agent-rishi\\runner\\runner.json",
    "Get-Content $env:AGENT_RISHI_HOME\\install-token,$env:AGENT_RISHI_HOME\\runner\\runner.json",
    // The credential file second, quoted elements, colon-bound and copied.
    "Get-Content README.md,$env:AGENT_RISHI_HOME\\remote-access.json",
    "Get-Content 'README.md','C:\\Users\\me\\.agent-rishi\\install-token'",
    'Get-Content "README.md",$env:AGENT_RISHI_HOME\\install-token',
    "Get-Content -Path:README.md,$env:AGENT_RISHI_HOME\\install-token",
    "gc README.md,$env:USERPROFILE\\.agent-rishi\\runner\\runner.json",
    "Copy-Item README.md,$env:AGENT_RISHI_HOME\\install-token C:\\Users\\me\\AppData\\Local\\Temp",
    "Get-Content README.md ,$env:AGENT_RISHI_HOME\\install-token",
    "Get-Content README.md,C:\\Users\\me\\.agent-rishi\\*",
  ];

  it("each element is checked, in PowerShell and when the shell is unknown", () => {
    for (const shell of ["powershell", "auto"] as const) {
      for (const cmd of lists)
        expect(guarded(cmd, { ...win, shell }), `${shell}: ${cmd}`).toBe(true);
    }
    // PowerShell on macOS or Linux.
    expect(
      guarded(
        "Get-Content /home/me/.agent-rishi/install-token,/home/me/.agent-rishi/runner/runner.json",
        {
          ...posix,
          shell: "powershell",
        },
      ),
    ).toBe(true);
    // An ordinary secrets file in a list asks like one on its own.
    expect(action("Get-Content README.md,.env", { ...win, shell: "powershell" })).toBe("secrets");
  });

  it("commas inside a quoted literal stay part of one name", () => {
    for (const shell of ["powershell", "auto"] as const) {
      const ctx = { ...win, shell };
      for (const cmd of [
        "Get-Content README.md,CHANGELOG.md",
        "Get-Content install-token,runner\\runner.json",
        "Select-String -Pattern 'a,b' -Path src\\*.ts",
        "Write-Output a,b",
      ]) {
        expect(action(cmd, ctx), `${shell}: ${cmd}`).toBeNull();
      }
      // Other files in the home ask as the home (#320), never as Agent Rishi's credentials.
      for (const cmd of [
        "Get-Content 'C:\\Users\\me\\.agent-rishi\\install-token,x'",
        'Get-Content "C:\\Users\\me\\.agent-rishi\\runner\\runner.json,bak"',
      ]) {
        expect(classifyCommand(cmd, ctx), `${shell}: ${cmd}`).toMatchObject({
          agentRishi: true,
          reason: expect.stringMatching(/own home/),
        });
      }
    }
  });
});

describe("an Agent Rishi home with glob characters in its name", () => {
  const homes: RiskContext[] = [
    { ...posix, agentRishiHome: "/tmp/Agent Rishi [dev]" },
    { ...posix, agentRishiHome: "/home/me/odd *?[x] home" },
    { ...posix, agentRishiHome: "/home/me/a]b" },
    { ...win, agentRishiHome: "C:\\Users\\me\\Agent Rishi [dev]" },
    { ...win, agentRishiHome: "C:\\Users\\me\\Code Den [a-z]" },
  ];

  it("Read, Write and Claude's Read guard all three files", () => {
    for (const ctx of homes) {
      const home = ctx.agentRishiHome as string;
      const sep = ctx.platform === "win32" ? "\\" : "/";
      for (const file of FILES) {
        const target = `${home}${sep}${file.replace("/", sep)}`;
        expect(classifyRead(target, ctx), target).toMatchObject({ risky: true, agentRishi: true });
        expect(classifyWrite(target, ctx), target).toMatchObject({ risky: true, agentRishi: true });
        expect(assessClaudeTool("Read", { file_path: target }, ctx), target).toMatchObject({
          agentRishi: true,
        });
      }
    }
  });

  it("searches, globs and shell commands reach them too", () => {
    for (const ctx of homes) {
      const home = ctx.agentRishiHome as string;
      const label = (what: string) => `${home}: ${what}`;
      expect(
        assessClaudeTool("Grep", { pattern: ".", path: home }, ctx),
        label("Grep"),
      ).toMatchObject({ agentRishi: true });
      expect(
        assessClaudeTool("Glob", { path: home, pattern: "install-token" }, ctx),
        label("Glob"),
      ).toMatchObject({ agentRishi: true });
      expect(
        assessClaudeTool("Glob", { path: home, pattern: "*" }, ctx),
        label("Glob *"),
      ).toMatchObject({ agentRishi: true });
      const commands =
        ctx.platform === "win32"
          ? [
              "Get-Content $env:AGENT_RISHI_HOME\\install-token",
              `Get-Content '${home}\\install-token'`,
            ]
          : [
              'cat "$AGENT_RISHI_HOME/install-token"',
              `cat '${home}/runner/runner.json'`,
              `cat '${home}'/*`,
              'grep -r token "$AGENT_RISHI_HOME"',
            ];
      for (const cmd of commands) expect(guarded(cmd, ctx), label(cmd)).toBe(true);
    }
  });

  it("a wildcard the agent writes below a bracketed folder still matches", () => {
    // The default home under a user folder whose name has brackets.
    const ctx: RiskContext = {
      ...posix,
      cwd: "/home/J [1]/src/app",
      home: "/home/J [1]",
      agentRishiHome: "/home/J [1]/.agent-rishi",
    };
    for (const cmd of [
      "cat ~/.agent*/install-token",
      "cat ~/.agent-rishi/runner/*.json",
      "cat ~/*/remote-access.json",
      "rg -g install-token . ~",
    ]) {
      expect(guarded(cmd, ctx), cmd).toBe(true);
    }
    // Another file in the home asks as the home, not as Agent Rishi's credentials (#320).
    expect(classifyCommand("cat ~/.agent*/settings.json", ctx)).toMatchObject({
      agentRishi: true,
      reason: expect.stringMatching(/own home/),
    });
    expect(action("cat ~/src/*/settings.json", ctx)).toBeNull();
  });

  it("files next to that home stay safe; other files in it ask as the home (#320)", () => {
    const ctx: RiskContext = { ...posix, agentRishiHome: "/tmp/Agent Rishi [dev]" };
    for (const target of [
      "/tmp/Agent Rishi d/install-token",
      "/tmp/Agent Rishi d/x",
      "install-token",
    ]) {
      expect(classifyRead(target, ctx), target).toEqual({ risky: false });
    }
    const asHome = { risky: true, agentRishi: true, reason: expect.stringMatching(/own home/) };
    for (const target of [
      "/tmp/Agent Rishi [dev]/logs/server.log",
      "/tmp/Agent Rishi [dev]/settings.json",
    ]) {
      expect(classifyRead(target, ctx), target).toMatchObject(asHome);
    }
    const onWindows: RiskContext = { ...win, agentRishiHome: "C:\\Users\\me\\Agent Rishi [dev]" };
    expect(classifyRead("C:\\Users\\me\\Agent Rishi d\\settings.json", onWindows)).toEqual({
      risky: false,
    });
    expect(
      classifyRead("C:\\Users\\me\\Agent Rishi [dev]\\settings.json", onWindows),
    ).toMatchObject(asHome);
    expect(
      assessClaudeTool(
        "Glob",
        { path: "C:\\Users\\me\\Agent Rishi [dev]", pattern: "logs/*" },
        onWindows,
      ),
    ).toMatchObject(asHome);
  });
});

describe("every level asks, read-only refuses, Codex never auto-approves", () => {
  const posixCommands = [
    "grep -e. /home/me/.agent-rishi/install-token",
    "rg -e. /home/me/.agent-rishi/runner/runner.json",
    "grep -ne. /home/me/.agent-rishi/remote-access.json",
    "rg --hidden -g install-token -e. /home/me",
    "grep -fpatterns.txt /home/me/.agent-rishi/install-token",
    "grep -re. /home/me",
  ];
  const pwshCommands = [
    "Get-Content -LiteralPath C:\\Users\\me\\.agent-rishi\\install-token,C:\\Users\\me\\.agent-rishi\\runner\\runner.json",
    "Select-String -Pattern . -Path C:\\Users\\me\\.agent-rishi\\install-token,C:\\Users\\me\\.agent-rishi\\runner\\runner.json",
    "Get-Content $env:AGENT_RISHI_HOME\\install-token,$env:AGENT_RISHI_HOME\\runner\\runner.json",
  ];
  const bracketHome: RiskContext = { ...win, agentRishiHome: "C:\\Users\\me\\Agent Rishi [dev]" };
  const bracketRead = { file_path: "C:\\Users\\me\\Agent Rishi [dev]\\install-token" };

  it("Claude", () => {
    for (const level of ["supervised", "auto", "full"] as const) {
      const bash = new ClaudePolicy(level, posix);
      for (const command of posixCommands) {
        expect(bash.gate("Bash", { command }), `${level}: ${command}`).toMatchObject({
          ask: true,
          action: "secrets",
        });
      }
      const pwsh = new ClaudePolicy(level, win);
      for (const command of pwshCommands) {
        expect(pwsh.gate("PowerShell", { command }), `${level}: ${command}`).toMatchObject({
          ask: true,
          action: "secrets",
        });
      }
      expect(new ClaudePolicy(level, bracketHome).gate("Read", bracketRead), level).toMatchObject({
        ask: true,
        action: "secrets",
      });
    }
    for (const isPm of [false, true]) {
      const level = isPm ? "full" : "read_only";
      const bash = new ClaudePolicy(level, posix, isPm);
      for (const command of posixCommands) {
        expect(bash.denial("Bash", { command }), command).toMatch(/off limits/);
      }
      const pwsh = new ClaudePolicy(level, win, isPm);
      for (const command of pwshCommands) {
        expect(pwsh.denial("PowerShell", { command }), command).toMatch(/off limits/);
      }
      expect(new ClaudePolicy(level, bracketHome, isPm).denial("Read", bracketRead)).toMatch(
        /off limits/,
      );
    }
  });

  it("OpenCode", () => {
    const shell = (command: string): PermissionCall => ({
      request: { id: "p", sessionID: "s", action: "shell", resources: [command] },
      toolName: "bash",
      toolInput: { command },
    });
    for (const level of ["supervised", "auto", "full"] as AutonomyLevel[]) {
      for (const command of posixCommands) {
        expect(new OpenCodePolicy(level, posix).decide(shell(command)), command).toMatchObject({
          kind: "ask",
          action: "secrets",
        });
      }
      for (const command of pwshCommands) {
        expect(new OpenCodePolicy(level, win).decide(shell(command)), command).toMatchObject({
          kind: "ask",
          action: "secrets",
        });
      }
    }
    for (const p of [
      new OpenCodePolicy("read_only", posix),
      new OpenCodePolicy("auto", posix, true),
    ]) {
      for (const command of posixCommands) {
        expect(p.decide(shell(command)), command).toMatchObject({ kind: "deny" });
      }
    }
    for (const p of [new OpenCodePolicy("read_only", win), new OpenCodePolicy("auto", win, true)]) {
      for (const command of pwshCommands) {
        expect(p.decide(shell(command)), command).toMatchObject({ kind: "deny" });
      }
    }
  });

  it("Codex", () => {
    for (const level of ["auto", "full"] as const) {
      for (const command of posixCommands) {
        expect(levelAllows(level, commandRisk([command], posix)), `${level}: ${command}`).toBe(
          false,
        );
      }
      for (const command of pwshCommands) {
        expect(levelAllows(level, commandRisk([command], win)), `${level}: ${command}`).toBe(false);
      }
    }
  });
});
