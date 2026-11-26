import type { AutonomyLevel } from "@agent-rishi/contracts";
import { describe, expect, it } from "vitest";
import { ClaudePolicy } from "../src/claude/permissions";
import { assessClaudeTool } from "../src/claude/tools";
import { commandRisk, levelAllows, patchRisk, permissionsRisk } from "../src/codex/policy";
import { OpenCodePolicy, type PermissionCall } from "../src/opencode/policy";
import { classifyCommand, classifyRead, classifyWrite, type RiskContext } from "../src/policy/risk";

/**
 * Agent Rishi's own credentials live as plain files in its home (§15): the install token the
 * loopback API accepts, the runner lock with the runner's bearer token, and the remote access
 * store. An agent that reads one can drive the API or the runner and approve its own requests,
 * so touching them asks at every level and is refused for read-only sessions (§11.2). The home
 * comes from the session (`SessionOptions.agentRishiHome`).
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

const action = (command: string, ctx: RiskContext) => {
  const r = classifyCommand(command, ctx);
  return r.risky ? r.action : null;
};
const guarded = (command: string, ctx: RiskContext) => {
  const r = classifyCommand(command, ctx);
  return r.risky && r.agentRishi === true;
};

describe("Agent Rishi's own credential files: the classifier", () => {
  it("a Claude Read or Grep of the install token, the runner lock or the remote access store", () => {
    for (const file_path of [
      "/home/me/.agent-rishi/install-token",
      "/home/me/.agent-rishi/runner/runner.json",
      "/home/me/.agent-rishi/remote-access.json",
      "~/.agent-rishi/install-token",
      "../../../install-token",
    ]) {
      expect(assessClaudeTool("Read", { file_path }, posix), file_path).toMatchObject({
        risky: true,
        action: "secrets",
        agentRishi: true,
      });
    }
    for (const file_path of [
      "C:\\Users\\me\\.agent-rishi\\install-token",
      "c:/users/me/.agent-rishi/RUNNER/runner.json",
    ]) {
      expect(assessClaudeTool("Read", { file_path }, win), file_path).toMatchObject({
        agentRishi: true,
      });
    }
    // Searching the home (or its runner folder) reads the files in it.
    expect(assessClaudeTool("Grep", { pattern: ".", path: "~/.agent-rishi" }, posix)).toMatchObject(
      {
        agentRishi: true,
      },
    );
    expect(
      assessClaudeTool("Grep", { pattern: ".", path: "/home/me/.agent-rishi/runner" }, posix),
    ).toMatchObject({ agentRishi: true });
    // A Grep filtered to the files' names, from a folder above the home, reads them too.
    expect(
      assessClaudeTool("Grep", { pattern: ".", path: "/home/me", glob: "install-token" }, posix),
    ).toMatchObject({ agentRishi: true });
    expect(assessClaudeTool("Grep", { pattern: "x", glob: "*.json" }, posix)).toEqual({
      risky: false,
    });
  });

  it("a Claude Glob that reaches them asks; ordinary globbing doesn't", () => {
    for (const input of [
      { path: "/home/me/.agent-rishi", pattern: "install-token" },
      { pattern: "/home/me/.agent-rishi/install-token" },
      { path: "/home/me/.agent-rishi", pattern: "*" },
      { path: "~/.agent-rishi", pattern: "runner/*.json" },
      { path: "/home/me", pattern: "**/remote-access.json" },
      { pattern: "../../../{install-token,x}" },
      // `**/` is zero or more folders: files right in the search folder count.
      { path: "/home/me/.agent-rishi", pattern: "**/install-token" },
      { path: "/home/me/.agent-rishi", pattern: "**/remote-access.json" },
      { path: "/home/me/.agent-rishi/runner", pattern: "**/runner.json" },
      { path: "/home/me/.agent-rishi", pattern: "**/runner.json" },
      { pattern: "/home/me/.agent-rishi/**/install-token" },
    ]) {
      expect(assessClaudeTool("Glob", input, posix), JSON.stringify(input)).toMatchObject({
        risky: true,
        agentRishi: true,
      });
    }
    for (const input of [
      { path: "C:\\Users\\me\\.agent-rishi", pattern: "*-token" },
      { path: "C:\\Users\\me\\.agent-rishi", pattern: "**/install-token" },
      { path: "C:\\Users\\me\\.agent-rishi\\runner", pattern: "**/runner.json" },
      { path: "C:\\Users\\me\\.agent-rishi", pattern: "**/runner.json" },
      { path: "C:\\Users\\me", pattern: "**/REMOTE-ACCESS.json" },
    ]) {
      expect(assessClaudeTool("Glob", input, win), JSON.stringify(input)).toMatchObject({
        agentRishi: true,
      });
    }
    for (const input of [
      { pattern: "**/*.ts" },
      { pattern: "**/*" },
      { pattern: "src/**/runner.json" },
      { path: "/home/me/.agent-rishi/wt/repo/abc123", pattern: "**/install-token" },
    ]) {
      expect(assessClaudeTool("Glob", input, posix), JSON.stringify(input)).toEqual({
        risky: false,
      });
    }
    // The rest of the home asks too, as the home (#320).
    for (const input of [
      { path: "/home/me/.agent-rishi", pattern: "logs/*.log" },
      { path: "/home/me/.agent-rishi", pattern: "**/*.log" },
      { path: "/home/me/.agent-rishi/runner", pattern: "**/install-token" },
    ]) {
      expect(assessClaudeTool("Glob", input, posix), JSON.stringify(input)).toMatchObject({
        agentRishi: true,
        reason: expect.stringMatching(/Agent Rishi's own home/),
      });
    }
  });

  it("classifyRead and classifyWrite flag them (Codex and OpenCode paths)", () => {
    expect(classifyRead("/home/me/.agent-rishi/install-token", posix)).toMatchObject({
      agentRishi: true,
    });
    expect(classifyRead("/home/me/.agent-rishi/runner/runner.json", posix)).toMatchObject({
      agentRishi: true,
    });
    expect(classifyWrite("/home/me/.agent-rishi/remote-access.json", posix)).toMatchObject({
      risky: true,
      agentRishi: true,
    });
  });

  it("POSIX shell reads, by path, through AGENT_RISHI_HOME, a wildcard or the folder", () => {
    for (const cmd of [
      "cat ~/.agent-rishi/install-token",
      "cat ~/.agent-rishi/runner/runner.json",
      'cat "$AGENT_RISHI_HOME/install-token"',
      "cat $AGENT_RISHI_HOME/runner/runner.json",
      // biome-ignore lint/suspicious/noTemplateCurlyInString: a shell variable, not a template
      "cat ${AGENT_RISHI_HOME}/remote-access.json",
      "head -c 64 ~/.agent-rishi/remote-access.json",
      "cat $HOME/.agent-rishi/install-token",
      "cat ~/.agent-rishi/*",
      "cat ~/.agent-rishi/install-*",
      "cat ~/.agent-rishi/runner/*.json",
      "cat ~/.agent-rishi/install-toke?",
      "cat ~/.agent-rishi/{install-token,x}",
      "cat $AGENT_RISHI_HOME/runner/{runner.json,}",
      "cd ~/.agent-rishi && cat install-token",
      "cd $AGENT_RISHI_HOME/runner && cat ./runner.json",
      "cat ../../../install-token",
      "grep -r token ~/.agent-rishi",
      "rg --hidden . $AGENT_RISHI_HOME",
      "tar czf /tmp/home.tgz ~/.agent-rishi",
      "cp ~/.agent-rishi/install-token /tmp/t",
      "git diff --no-index ~/.agent-rishi/install-token /dev/null",
      "bash -c 'cat ~/.agent-rishi/install-token'",
      "find ~/.agent-rishi -name install-token -exec cat {} \\;",
    ]) {
      expect(action(cmd, posix), cmd).toBe("secrets");
      expect(guarded(cmd, posix), cmd).toBe(true);
    }
  });

  it("PowerShell and cmd reads, by path or through AGENT_RISHI_HOME", () => {
    for (const cmd of [
      "Get-Content $env:AGENT_RISHI_HOME\\install-token",
      "Get-Content -Path $env:AGENT_RISHI_HOME\\runner\\runner.json",
      "gc $env:USERPROFILE\\.agent-rishi\\remote-access.json",
      "Get-Content $env:USERPROFILE\\.agent-rishi\\runner\\runner.json",
      "type %USERPROFILE%\\.agent-rishi\\install-token",
      "type %AGENT_RISHI_HOME%\\install-token",
      "Get-Content C:\\Users\\me\\.agent-rishi\\*",
      "Select-String -Pattern token -Path $env:AGENT_RISHI_HOME\\install-token",
      // Colon-bound parameters.
      "Get-Content -LiteralPath:$env:AGENT_RISHI_HOME\\runner\\runner.json",
      "Get-Content -Path:C:\\Users\\me\\.agent-rishi\\install-token",
      "Select-String -Pattern . -Path:$env:AGENT_RISHI_HOME\\runner\\runner.json",
      "Select-String -Pattern:x $env:AGENT_RISHI_HOME\\install-token",
      "Set-Location -Path:$env:AGENT_RISHI_HOME; Get-Content install-token",
    ]) {
      expect(guarded(cmd, win), cmd).toBe(true);
    }
  });

  it("writes and deletes ask too", () => {
    for (const cmd of [
      "echo x > ~/.agent-rishi/install-token",
      "cp evil.json $AGENT_RISHI_HOME/remote-access.json",
      "rm ~/.agent-rishi/runner/runner.json",
    ]) {
      expect(guarded(cmd, posix), cmd).toBe(true);
    }
    for (const cmd of [
      "Set-Content $env:AGENT_RISHI_HOME\\install-token x",
      "Set-Content -Path:$env:AGENT_RISHI_HOME\\install-token -Value x",
      "Out-File -FilePath:$env:AGENT_RISHI_HOME\\runner\\runner.json",
      "Copy-Item evil.json -Destination:$env:AGENT_RISHI_HOME\\remote-access.json",
    ]) {
      expect(guarded(cmd, win), cmd).toBe(true);
    }
  });

  it("an earlier ordinary risk can't hide them, nested or inline", () => {
    for (const cmd of [
      "cat .env; cat ~/.agent-rishi/install-token",
      "cat .env; echo x > ~/.agent-rishi/install-token",
      "git push --force && cat $AGENT_RISHI_HOME/runner/runner.json",
      "sudo cat ~/.agent-rishi/install-token",
      "npm i -g x; bash -c 'cat ~/.agent-rishi/install-token'",
      "echo $(cat .env) $(cat ~/.agent-rishi/install-token)",
      "printenv; cp ~/.agent-rishi/remote-access.json /tmp/x",
    ]) {
      expect(guarded(cmd, posix), cmd).toBe(true);
    }
    expect(
      guarded(
        "Get-Content .env; Get-Content -LiteralPath:$env:AGENT_RISHI_HOME\\install-token",
        win,
      ),
    ).toBe(true);
  });

  it("a search pattern that repeats a file operand doesn't hide the file", () => {
    for (const cmd of [
      "grep -e . -e /home/me/.agent-rishi/install-token /home/me/.agent-rishi/install-token",
      "rg -e . -e /home/me/.agent-rishi/runner/runner.json /home/me/.agent-rishi/runner/runner.json",
      "grep /home/me/.agent-rishi/install-token /home/me/.agent-rishi/install-token",
      "rg --regexp=~/.agent-rishi/install-token ~/.agent-rishi/install-token",
    ]) {
      expect(guarded(cmd, posix), cmd).toBe(true);
    }
    expect(
      guarded(
        "Select-String -Pattern $env:AGENT_RISHI_HOME\\install-token -Path $env:AGENT_RISHI_HOME\\install-token",
        win,
      ),
    ).toBe(true);
    // A pattern that only names the file searches other files for that text.
    for (const cmd of [
      "grep -e ~/.agent-rishi/install-token README.md",
      "rg ~/.agent-rishi/install-token docs",
    ]) {
      expect(guarded(cmd, posix), cmd).toBe(false);
    }
  });

  it("a recursive search, or a listing that feeds a command, from a folder above them", () => {
    for (const cmd of [
      "rg --hidden --no-ignore -g install-token . /home/me",
      "rg -g '*.json' token ~",
      "rg --glob=remote-access.json . /home",
      "rg -g '**/install-token' . ~",
      "rg token ~",
      "grep -r token ~",
      "grep -rn --include=install-token . /home/me",
      "grep -R x /",
      "grep -d recurse x ~",
      "cd ~ && rg token",
      "find ~ -name install-token | xargs cat",
      "find ~ -name install-token -exec cat {} \\;",
      "find / -iname runner.json -print0 | xargs -0 cat",
      "cat $(find ~ -name install-token)",
      "fd install-token ~ -x cat",
      "ls ~/.agent-rishi | xargs -I{} cat ~/.agent-rishi/{}",
      "echo ~/.agent-rishi/install-token | xargs cat",
      "xargs cat <<< ~/.agent-rishi/install-token",
      "cat $AGENT_RISHI_HOME/$name",
    ]) {
      expect(guarded(cmd, posix), cmd).toBe(true);
    }
    for (const cmd of [
      "findstr /s token C:\\Users\\me\\install-token",
      "findstr /s /i x %USERPROFILE%\\*.json",
      "Get-ChildItem -Recurse -Path ~ -Filter install-token | Get-Content",
      "gci $env:USERPROFILE -r -Include *.json | Select-String token",
      "Get-ChildItem $env:AGENT_RISHI_HOME | Get-Content",
    ]) {
      expect(guarded(cmd, win), cmd).toBe(true);
    }
    // Other folders, and listings only shown to the user, don't.
    for (const cmd of [
      "rg -g '!*.ts' token src",
      "rg token src",
      "grep -r token .",
      "grep token ~",
      "find . -name install-token | xargs cat",
      "find ~ -name install-token",
      "ls -R ~",
      "ls ~ | head",
      "echo hello | grep h",
    ]) {
      expect(guarded(cmd, posix), cmd).toBe(false);
    }
    expect(guarded("findstr /s token *.ts", win)).toBe(false);
    // Name filters that leave the credential files out still read the rest of the home, other
    // sessions' worktrees included, so they ask as the home (#320).
    for (const cmd of [
      "rg -g '*.ts' token ~",
      "grep -rn --include=*.md token ~",
      "find ~ -name '*.ts' | xargs wc -l",
    ]) {
      expect(classifyCommand(cmd, posix), cmd).toMatchObject({
        agentRishi: true,
        reason: expect.stringMatching(/Agent Rishi's own home/),
      });
    }
  });

  it("leaves same-named files elsewhere and other commands alone", () => {
    for (const cmd of [
      // A project's own files with the same names, in the worktree.
      "cat runner/runner.json",
      "cat install-token",
      "cat remote-access.json",
      "cat /home/me/.agent-rishi/wt/repo/abc123/runner/runner.json",
      "pnpm test",
      "cd ~/.agent-rishi/wt/repo/abc123 && pnpm build",
      "cd $AGENT_RISHI_HOME",
      'rg -n "install-token" apps/server/src',
      "echo ~/.agent-rishi/install-token",
      "git log --oneline",
    ]) {
      expect(action(cmd, posix), cmd).toBeNull();
    }
    // The rest of the home is not a credential file, but asks as the home (#320).
    for (const cmd of [
      "ls ~/.agent-rishi",
      "ls -la $AGENT_RISHI_HOME/runner",
      "cat ~/.agent-rishi/logs/server.log",
      "cat ~/.agent-rishi/settings.json",
    ]) {
      expect(classifyCommand(cmd, posix), cmd).toMatchObject({
        agentRishi: true,
        reason: expect.stringMatching(/Agent Rishi's own home/),
      });
    }
    for (const file of ["install-token", "remote-access.json", "runner/runner.json"]) {
      expect(classifyRead(file, posix), file).toEqual({ risky: false });
      expect(classifyWrite(file, posix), file).toEqual({ risky: false });
      expect(assessClaudeTool("Read", { file_path: file }, posix), file).toEqual({ risky: false });
      expect(
        assessClaudeTool(
          "Read",
          { file_path: `/home/me/.agent-rishi/wt/repo/abc123/${file}` },
          posix,
        ),
        file,
      ).toEqual({ risky: false });
    }
    expect(action("Get-Content install-token", win)).toBeNull();
    // Without the session's home the rule is off.
    const { agentRishiHome: _, ...noHome } = posix;
    expect(classifyRead("/home/me/.agent-rishi/runner/runner.json", noHome)).toEqual({
      risky: false,
    });
  });
});

describe("Agent Rishi's own credential files: every level", () => {
  const read = { file_path: "/home/me/.agent-rishi/install-token" };
  const cat = { command: "cat $AGENT_RISHI_HOME/runner/runner.json" };
  /** An ordinary risk first, which Full allows, then Agent Rishi's credentials. */
  const masked = [
    "cat .env; cat ~/.agent-rishi/install-token",
    "cat .env; echo x > ~/.agent-rishi/install-token",
    "git push --force; cat $AGENT_RISHI_HOME/runner/runner.json",
  ];
  /** Searches that read them through a repeated pattern or from a folder above them. */
  const searches = [
    "grep -e . -e /home/me/.agent-rishi/install-token /home/me/.agent-rishi/install-token",
    "rg -e . -e /home/me/.agent-rishi/runner/runner.json /home/me/.agent-rishi/runner/runner.json",
    "rg --hidden --no-ignore -g install-token . /home/me",
    "find ~ -name install-token | xargs cat",
  ];
  const colonBound = [
    "Get-Content -LiteralPath:$env:AGENT_RISHI_HOME\\runner\\runner.json",
    "Select-String -Pattern . -Path:$env:AGENT_RISHI_HOME\\runner\\runner.json",
    "Set-Content -Path:$env:AGENT_RISHI_HOME\\install-token -Value x",
  ];

  it("Claude asks under Supervised, Auto and Full", () => {
    for (const level of ["supervised", "auto", "full"] as const) {
      const p = new ClaudePolicy(level, posix);
      expect(p.denial("Read", read), level).toBeUndefined();
      expect(p.gate("Read", read), level).toMatchObject({ ask: true, action: "secrets" });
      expect(p.gate("Bash", cat), level).toMatchObject({ ask: true, action: "secrets" });
      expect(
        p.gate("Write", { file_path: "/home/me/.agent-rishi/install-token" }),
        level,
      ).toMatchObject({ ask: true });
      for (const [tool, input] of [
        ["Glob", { path: "/home/me/.agent-rishi", pattern: "install-token" }],
        ["Glob", { path: "/home/me/.agent-rishi", pattern: "**/install-token" }],
        ["Grep", { pattern: ".", path: "/home/me", glob: "install-token" }],
      ] as const) {
        expect(p.gate(tool, input), `${level}: ${tool}`).toMatchObject({ ask: true });
      }
      for (const command of [...masked, ...searches]) {
        expect(p.gate("Bash", { command }), `${level}: ${command}`).toMatchObject({
          ask: true,
          action: "secrets",
          reason: expect.stringMatching(/Agent Rishi's own credentials/),
        });
      }
      const pwsh = new ClaudePolicy(level, win);
      for (const command of colonBound) {
        expect(pwsh.gate("PowerShell", { command }), `${level}: ${command}`).toMatchObject({
          ask: true,
          action: "secrets",
        });
      }
    }
    // Under Full an ordinary secrets read still runs.
    expect(new ClaudePolicy("full", posix).gate("Read", { file_path: ".env" }).ask).toBe(false);
    expect(new ClaudePolicy("full", posix).gate("Bash", { command: "cat .env" }).ask).toBe(false);
  });

  it("Claude refuses them at Read-only and for the orchestrator and PMs", () => {
    for (const p of [new ClaudePolicy("read_only", posix), new ClaudePolicy("full", posix, true)]) {
      expect(p.denial("Read", read)).toMatch(/credential files are off limits/);
      expect(p.denial("Bash", cat)).toMatch(/credential files are off limits/);
      expect(p.denial("Grep", { pattern: "x", path: "~/.agent-rishi" })).toMatch(/off limits/);
      expect(p.denial("Glob", { pattern: "/home/me/.agent-rishi/*" })).toMatch(/off limits/);
      expect(
        p.denial("Glob", { path: "/home/me/.agent-rishi", pattern: "**/install-token" }),
      ).toMatch(/off limits/);
      for (const command of [...masked, ...searches]) {
        expect(p.denial("Bash", { command }), command).toMatch(/off limits/);
      }
      // Relative paths resolve from the shell's current directory.
      expect(p.denial("Bash", { command: "cat install-token" }, "/home/me/.agent-rishi")).toMatch(
        /off limits/,
      );
      expect(p.denial("Read", { file_path: "src/a.ts" })).toBeUndefined();
    }
    const pwsh = new ClaudePolicy("read_only", win);
    for (const command of colonBound) {
      expect(pwsh.denial("PowerShell", { command }), command).toMatch(/off limits/);
    }
  });

  it("a session approval covers them only as given: same call, same directory", () => {
    const worktree = posix.cwd;
    const home = "/home/me/.agent-rishi";
    const p = new ClaudePolicy("supervised", posix);
    // A harmless read of the repository's own file, approved for the session...
    const repoRead = { command: "cat runner/runner.json" };
    expect(p.gate("Bash", repoRead, worktree).ask).toBe(true);
    p.allowForSession("Bash", repoRead, worktree);
    expect(p.gate("Bash", repoRead, worktree).ask).toBe(false);
    // ...doesn't approve the same words once the shell is in Agent Rishi's home.
    expect(p.gate("Bash", repoRead, home)).toMatchObject({ ask: true, action: "secrets" });
    expect(p.needsUser("Bash", repoRead, home).ask).toBe(true);
    // Approving the credential read itself covers that call, there.
    p.allowForSession("Bash", repoRead, home);
    expect(p.gate("Bash", repoRead, home).ask).toBe(false);
    expect(p.gate("Bash", repoRead, worktree).ask).toBe(false);

    // Approving the Read tool for the session doesn't cover them; approving one does.
    const auto = new ClaudePolicy("auto", posix);
    auto.allowForSession("Read", { file_path: ".env" });
    expect(auto.gate("Read", { file_path: ".env.local" }).ask).toBe(false);
    expect(auto.gate("Read", read).ask).toBe(true);
    auto.allowForSession("Read", read);
    expect(auto.gate("Read", read).ask).toBe(false);
    expect(auto.gate("Read", { file_path: "/home/me/.agent-rishi/remote-access.json" }).ask).toBe(
      true,
    );
  });

  describe("OpenCode", () => {
    const shell = (command: string, workdir?: string): PermissionCall => ({
      request: { id: "p", sessionID: "s", action: "shell", resources: [command] },
      toolName: "bash",
      toolInput: { command, ...(workdir ? { workdir } : {}) },
    });
    const outside = (resource: string): PermissionCall => ({
      request: { id: "p", sessionID: "s", action: "external_directory", resources: [resource] },
    });
    const edit = (file: string): PermissionCall => ({
      request: { id: "p", sessionID: "s", action: "edit", resources: [file] },
    });

    it("asks at every level", () => {
      for (const level of ["supervised", "auto", "full"] as AutonomyLevel[]) {
        const p = new OpenCodePolicy(level, posix);
        expect(p.decide(shell("cat ~/.agent-rishi/install-token")), level).toMatchObject({
          kind: "ask",
          action: "secrets",
        });
        for (const command of [...masked, ...searches]) {
          expect(p.decide(shell(command)), `${level}: ${command}`).toMatchObject({
            kind: "ask",
            action: "secrets",
          });
        }
        // OpenCode names the folder of a file outside the worktree.
        expect(p.decide(outside("/home/me/.agent-rishi/*")), level).toMatchObject({ kind: "ask" });
        expect(p.decide(outside("/home/me/.agent-rishi/runner/*")), level).toMatchObject({
          kind: "ask",
        });
        expect(p.decide(edit("/home/me/.agent-rishi/remote-access.json")), level).toMatchObject({
          kind: "ask",
        });
        const onWindows = new OpenCodePolicy(level, win);
        for (const command of colonBound) {
          expect(onWindows.decide(shell(command)), `${level}: ${command}`).toMatchObject({
            kind: "ask",
          });
        }
      }
      expect(new OpenCodePolicy("full", posix).decide(outside("/home/me/other/*"))).toEqual({
        kind: "allow",
      });
      expect(new OpenCodePolicy("full", posix).decide(shell("cat .env"))).toEqual({
        kind: "allow",
      });
    });

    it("refuses read-only sessions, the orchestrator and PMs", () => {
      for (const p of [
        new OpenCodePolicy("read_only", posix),
        new OpenCodePolicy("auto", posix, true),
      ]) {
        expect(p.decide(shell("cat ~/.agent-rishi/install-token"))).toMatchObject({
          kind: "deny",
          message: expect.stringMatching(/off limits/),
        });
        for (const command of [...masked, ...searches]) {
          expect(p.decide(shell(command)), command).toMatchObject({ kind: "deny" });
        }
        expect(p.decide(outside("/home/me/.agent-rishi/*"))).toMatchObject({ kind: "deny" });
        expect(p.decide(shell("cat README.md"))).toEqual({ kind: "allow" });
      }
    });

    it("a command approved for the session covers it in that directory only", () => {
      const p = new OpenCodePolicy("supervised", posix);
      const repoRead = shell("cat runner/runner.json");
      p.allowForSession(repoRead);
      expect(p.decide(repoRead)).toEqual({ kind: "allow" });
      expect(p.decide(shell("cat runner/runner.json", "/home/me/.agent-rishi"))).toMatchObject({
        kind: "ask",
        action: "secrets",
      });
    });
  });

  it("Codex: requests that reach Agent Rishi are never approved by policy", () => {
    for (const level of ["auto", "full"] as const) {
      for (const texts of [
        ["cat ~/.agent-rishi/install-token"],
        ...[...masked, ...searches].map((command) => [command]),
        // The command line as sent, then Codex's parsed actions.
        ["cat .env", "cat ~/.agent-rishi/install-token"],
      ]) {
        expect(levelAllows(level, commandRisk(texts, posix)), `${level}: ${texts}`).toBe(false);
      }
      for (const command of colonBound) {
        expect(levelAllows(level, commandRisk([command], win)), `${level}: ${command}`).toBe(false);
      }
      expect(
        levelAllows(level, patchRisk(["/home/me/.agent-rishi/remote-access.json"], null, posix)),
        level,
      ).toBe(false);
      expect(
        levelAllows(
          level,
          permissionsRisk(
            { network: null, fileSystem: { read: [".env", "/home/me/.agent-rishi"], write: null } },
            posix,
          ),
        ),
        level,
      ).toBe(false);
    }
    expect(levelAllows("full", commandRisk(["cat .env"], posix))).toBe(true);
  });
});
