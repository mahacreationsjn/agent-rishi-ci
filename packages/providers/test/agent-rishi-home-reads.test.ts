import { describe, expect, it } from "vitest";
import { ClaudePolicy } from "../src/claude/permissions";
import { assessClaudeTool } from "../src/claude/tools";
import { classifyCommand, classifyRead, type RiskContext } from "../src/policy/risk";

/**
 * Agent Rishi's whole home is off limits to agents (#320), not only its credential files: the
 * SQLite database (and its `-wal`/`-shm` files) holds other sessions' transcripts, inbox items
 * and MCP token hashes; settings, logs and backups hold the rest. Reading, listing, copying or
 * searching anything there asks at every level, Full included. Agent Rishi state reaches agents
 * through its MCP tools instead. The one exception is the session's own worktree under
 * `<home>/wt/`: another session's worktree asks.
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
/** A custom `AGENT_RISHI_HOME` outside the user's home folder. */
const custom: RiskContext = {
  cwd: "/data/agent-rishi-dev/wt/repo/abc123",
  platform: "linux",
  home: "/home/me",
  tempRoots: ["/tmp"],
  agentRishiHome: "/data/agent-rishi-dev",
};

const guarded = (command: string, ctx: RiskContext) => {
  const r = classifyCommand(command, ctx);
  return r.risky && r.agentRishi === true;
};

/** Reads, listings, searches and copies of the database and the runner's folder. */
const POSIX_READS = [
  "cat ~/.agent-rishi/agent-rishi.db",
  "cat /home/me/.agent-rishi/agent-rishi.db-wal",
  "head -c 100 $AGENT_RISHI_HOME/agent-rishi.db-shm",
  'sqlite3 ~/.agent-rishi/agent-rishi.db "select * from events"',
  "sqlite3 -readonly $AGENT_RISHI_HOME/agent-rishi.db .tables",
  "ls ~/.agent-rishi",
  "ls -la $AGENT_RISHI_HOME/runner",
  "ls /home/me/.agent-rishi/runner/",
  "cat ~/.agent-rishi/runner/runner.log",
  "cat ~/.agent-rishi/runner/*",
  "rg token ~/.agent-rishi/runner",
  "rg factory_report_findings ~/.agent-rishi/agent-rishi.db",
  "grep -a findings ~/.agent-rishi/agent-rishi.db",
  "cp ~/.agent-rishi/agent-rishi.db /tmp/db",
  "cp -r $AGENT_RISHI_HOME/runner /tmp/r",
  "cat ~/.agent-rishi/settings.json",
  "cat ~/.agent-rishi/logs/server.log",
  "tail -f ~/.agent-rishi/logs/server.log",
  "ls ~/.agent-rishi/backups",
  "cd ~/.agent-rishi && sqlite3 agent-rishi.db .dump",
  "cd ~/.agent-rishi && ls",
  "python3 -c 'print(1)' ~/.agent-rishi/agent-rishi.db",
  "strings ~/.agent-rishi/agent-rishi.db",
  "xxd ~/.agent-rishi/agent-rishi.db-wal",
  "find ~/.agent-rishi -name '*.db'",
];

describe("Agent Rishi's whole home: the classifier (#320)", () => {
  it("reading, listing, searching or copying the database and the runner folder asks", () => {
    for (const cmd of POSIX_READS) {
      expect(guarded(cmd, posix), cmd).toBe(true);
    }
  });

  it("a custom AGENT_RISHI_HOME is guarded the same way", () => {
    for (const cmd of [
      "cat /data/agent-rishi-dev/agent-rishi.db",
      "sqlite3 /data/agent-rishi-dev/agent-rishi.db .tables",
      "ls /data/agent-rishi-dev",
      "ls $AGENT_RISHI_HOME/runner",
      "cp /data/agent-rishi-dev/agent-rishi.db-wal /tmp/x",
      "rg x /data/agent-rishi-dev/runner",
    ]) {
      expect(guarded(cmd, custom), cmd).toBe(true);
    }
  });

  it("PowerShell and cmd reads of the database and the runner folder ask", () => {
    for (const cmd of [
      "Get-Content $env:AGENT_RISHI_HOME\\agent-rishi.db",
      "Get-Content C:\\Users\\me\\.agent-rishi\\agent-rishi.db-wal",
      "sqlite3 C:\\Users\\me\\.agent-rishi\\agent-rishi.db .tables",
      "Get-ChildItem $env:AGENT_RISHI_HOME",
      "Get-ChildItem C:\\Users\\me\\.agent-rishi\\runner",
      "dir %USERPROFILE%\\.agent-rishi",
      "type %AGENT_RISHI_HOME%\\settings.json",
      "Copy-Item $env:AGENT_RISHI_HOME\\agent-rishi.db $env:TEMP\\db",
      "Select-String -Pattern findings -Path C:\\Users\\me\\.agent-rishi\\agent-rishi.db",
    ]) {
      expect(guarded(cmd, win), cmd).toBe(true);
    }
  });

  it("Claude's Read, Grep and Glob of the home ask", () => {
    for (const file_path of [
      "/home/me/.agent-rishi/agent-rishi.db",
      "/home/me/.agent-rishi/agent-rishi.db-wal",
      "/home/me/.agent-rishi/settings.json",
      "/home/me/.agent-rishi/logs/server.log",
      "/home/me/.agent-rishi/runner/runner.log",
      "~/.agent-rishi/backups/settings.json",
    ]) {
      expect(assessClaudeTool("Read", { file_path }, posix), file_path).toMatchObject({
        risky: true,
        agentRishi: true,
      });
      expect(classifyRead(file_path, posix), file_path).toMatchObject({ agentRishi: true });
    }
    for (const input of [
      { pattern: "findings", path: "/home/me/.agent-rishi/logs" },
      { pattern: "findings", path: "/home/me/.agent-rishi/agent-rishi.db" },
    ]) {
      expect(assessClaudeTool("Grep", input, posix), JSON.stringify(input)).toMatchObject({
        agentRishi: true,
      });
    }
    for (const input of [
      { path: "/home/me/.agent-rishi", pattern: "*.db" },
      { path: "/home/me/.agent-rishi", pattern: "logs/*.log" },
      { path: "/home/me/.agent-rishi", pattern: "**/*.log" },
      { pattern: "/home/me/.agent-rishi/runner/*" },
    ]) {
      expect(assessClaudeTool("Glob", input, posix), JSON.stringify(input)).toMatchObject({
        agentRishi: true,
      });
    }
  });

  it("the session's own worktree under the home stays readable", () => {
    for (const cmd of [
      "cat /home/me/.agent-rishi/wt/repo/abc123/src/a.ts",
      "cat src/a.ts",
      "ls",
      "ls /home/me/.agent-rishi/wt/repo/abc123",
      "rg token .",
      "rg token /home/me/.agent-rishi/wt/repo/abc123",
      "cp src/a.ts /tmp/a.ts",
      "cat $AGENT_RISHI_HOME/wt/repo/abc123/package.json",
      "cd ~/.agent-rishi/wt/repo/abc123 && pnpm build",
    ]) {
      expect(classifyCommand(cmd, posix), cmd).toEqual({ risky: false });
    }
    expect(
      assessClaudeTool(
        "Read",
        { file_path: "/home/me/.agent-rishi/wt/repo/abc123/src/a.ts" },
        posix,
      ),
    ).toEqual({ risky: false });
    expect(
      assessClaudeTool(
        "Glob",
        { path: "/home/me/.agent-rishi/wt/repo/abc123", pattern: "**/*" },
        posix,
      ),
    ).toEqual({ risky: false });
    expect(classifyCommand("Get-Content src\\a.ts", win)).toEqual({ risky: false });
    expect(
      classifyCommand("Get-Content C:\\Users\\me\\.agent-rishi\\wt\\repo\\abc123\\src\\a.ts", win),
    ).toEqual({ risky: false });
  });

  it("another session's worktree under the home asks", () => {
    for (const cmd of [
      "cat /home/me/.agent-rishi/wt/repo/zzz999/src/a.ts",
      "cat ../zzz999/src/a.ts",
      "ls ~/.agent-rishi/wt/repo",
      "ls ~/.agent-rishi/wt/other/def456",
      "rg token ~/.agent-rishi/wt",
    ]) {
      expect(guarded(cmd, posix), cmd).toBe(true);
    }
    expect(
      assessClaudeTool(
        "Read",
        { file_path: "/home/me/.agent-rishi/wt/repo/zzz999/src/a.ts" },
        posix,
      ),
    ).toMatchObject({ agentRishi: true });
    expect(
      guarded("Get-Content C:\\Users\\me\\.agent-rishi\\wt\\repo\\zzz999\\src\\a.ts", win),
    ).toBe(true);
  });

  it("leaves the rest of the machine alone", () => {
    for (const cmd of ["cat ~/notes.txt", "ls ~", "ls /home/me/projects", "cat /etc/hosts"]) {
      expect(classifyCommand(cmd, posix), cmd).toEqual({ risky: false });
    }
    // Without the session's home the rule is off.
    const { agentRishiHome: _, ...noHome } = posix;
    expect(classifyRead("/home/me/.agent-rishi/agent-rishi.db", noHome)).toEqual({ risky: false });
  });
});

describe("Agent Rishi's whole home: every level (#320)", () => {
  it("Claude asks under Auto and Full, and refuses at Read-only", () => {
    for (const level of ["auto", "full"] as const) {
      const p = new ClaudePolicy(level, posix);
      for (const command of POSIX_READS) {
        expect(p.gate("Bash", { command }), `${level}: ${command}`).toMatchObject({ ask: true });
      }
      expect(
        p.gate("Read", { file_path: "/home/me/.agent-rishi/agent-rishi.db" }),
        level,
      ).toMatchObject({
        ask: true,
      });
      expect(p.gate("Bash", { command: "cat src/a.ts" }), level).toMatchObject({ ask: false });
      expect(
        p.gate("Bash", { command: "cat /home/me/.agent-rishi/wt/repo/zzz999/src/a.ts" }),
        level,
      ).toMatchObject({ ask: true });
    }
    const readOnly = new ClaudePolicy("read_only", posix);
    expect(
      readOnly.denial("Bash", { command: "sqlite3 ~/.agent-rishi/agent-rishi.db .tables" }),
    ).toMatch(/off limits/);
    expect(readOnly.denial("Read", { file_path: "src/a.ts" })).toBeUndefined();
  });
});
