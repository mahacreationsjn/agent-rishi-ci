import { describe, expect, it } from "vitest";
import type { AcpToolState } from "../src/acp/items";
import { AcpPolicy } from "../src/acp/policy";
import { ClaudePolicy } from "../src/claude/permissions";
import { levelAllows } from "../src/codex/policy";
import { classifyCommand, classifyRead, classifyWrite, type RiskContext } from "../src/policy/risk";

/**
 * Issue #389: `.agent-rishi/automations/*.md` defines what project automations run (prompt,
 * permissions, schedule) and `.agent-rishi/VISION.md` the factory's protected areas. Writing them
 * asks at Auto, like `.agent-rishi/project.json`.
 */

const posix: RiskContext = {
  cwd: "/work/repo",
  platform: "linux",
  home: "/home/me",
  tempRoots: ["/tmp"],
};
const win: RiskContext = {
  cwd: "C:\\work\\repo",
  platform: "win32",
  home: "C:\\Users\\me",
  tempRoots: ["C:\\Users\\me\\AppData\\Local\\Temp"],
};

const reason = (command: string, ctx: RiskContext = posix) => {
  const r = classifyCommand(command, ctx);
  return r.risky ? r.reason : null;
};

describe("Agent Rishi's automation files and vision (#389)", () => {
  it("asks before an edit of .agent-rishi/automations/*.md and .agent-rishi/VISION.md", () => {
    for (const file of [
      ".agent-rishi/automations/x.md",
      "/work/repo/.agent-rishi/automations/nightly.md",
      ".agent-rishi/VISION.md",
      "/work/repo/.agent-rishi/vision.md",
    ]) {
      const verdict = classifyWrite(file, posix);
      expect(verdict, file).toMatchObject({ risky: true, action: "file_change" });
      // Not an every-level verdict: Full runs it.
      expect(verdict.risky && verdict.always, file).toBeFalsy();
    }
    expect(classifyWrite(".agent-rishi\\Automations\\x.md", win)).toMatchObject({ risky: true });
    expect(classifyWrite(".agent-rishi\\VISION.md", win)).toMatchObject({ risky: true });
  });

  it("asks before a shell write of them, naming what the file is", () => {
    for (const command of [
      "echo x > .agent-rishi/automations/x.md",
      "echo x | tee .agent-rishi/automations/x.md",
      "cp /tmp/evil.md .agent-rishi/automations/",
      "cp /tmp/evil.md .agent-rishi/automations",
      "sed -i 's/read_only/full/' .agent-rishi/automations/audit.md",
      "git checkout origin/evil -- .agent-rishi/automations/audit.md",
      `node -e "require('fs').writeFileSync('.agent-rishi/automations/x.md', 'x')"`,
      "cd .agent-rishi/automations && echo x > x.md",
    ]) {
      expect(reason(command), command).toContain("automation file");
    }
    for (const command of [
      "echo vision > .agent-rishi/VISION.md",
      "cp /tmp/v.md .agent-rishi/VISION.md",
      `python -c "open('.agent-rishi/VISION.md','w').write('x')"`,
    ]) {
      expect(reason(command), command).toContain("vision");
    }
    expect(
      reason("Set-Content -Path .agent-rishi\\automations\\x.md -Value x", {
        ...win,
        shell: "powershell",
      }),
    ).toContain("automation file");
  });

  it("asks at Auto and Supervised, runs at Full, for every provider", () => {
    for (const path of [
      "/work/repo/.agent-rishi/automations/x.md",
      "/work/repo/.agent-rishi/VISION.md",
    ]) {
      const edit: AcpToolState = { toolCallId: "e", kind: "edit", locations: [{ path }] };
      expect(new AcpPolicy("auto", posix).decide(edit).kind, path).toBe("ask");
      expect(new AcpPolicy("full", posix).decide(edit).kind, path).toBe("allow");
      expect(new ClaudePolicy("auto", posix).gate("Write", { file_path: path }).ask, path).toBe(
        true,
      );
      expect(new ClaudePolicy("full", posix).gate("Write", { file_path: path }).ask, path).toBe(
        false,
      );
      const verdict = classifyWrite(path, posix);
      expect(levelAllows("auto", verdict), path).toBe(false);
      expect(levelAllows("full", verdict), path).toBe(true);
    }
  });

  it("leaves reads, the notes file and look-alike paths alone", () => {
    for (const command of [
      "cat .agent-rishi/automations/x.md",
      "ls .agent-rishi/automations",
      "git diff -- .agent-rishi/automations .agent-rishi/VISION.md",
      "echo note >> .agent-rishi/notes.md",
      "echo x > docs/automations/x.md",
      "echo x > .agent-rishi-automations.md",
    ]) {
      expect(classifyCommand(command, posix).risky, command).toBe(false);
    }
    expect(classifyRead(".agent-rishi/automations/x.md", posix).risky).toBe(false);
    expect(classifyWrite("docs/VISION.md", posix).risky).toBe(false);
    expect(classifyWrite(".agent-rishi/sub/VISION.md", posix).risky).toBe(false);
  });
});
