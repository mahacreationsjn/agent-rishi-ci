import { describe, expect, it } from "vitest";
import { ClaudePolicy } from "../src/claude/permissions";
import { levelAllows } from "../src/codex/policy";
import { fromDevicePath } from "../src/policy/device-paths";
import { classifyCommand, type RiskContext } from "../src/policy/risk";

/**
 * Path forms that name another place than they seem to (#663 review): Windows device paths
 * (`\\?\C:\x` is `C:\x`), and PowerShell's own values glued into a path, which a POSIX shell (and
 * PowerShell, for `$null`) expands to nothing (`"$null/home/me/x"` is `/home/me/x`).
 */

const win: RiskContext = {
  cwd: "C:\\Users\\me\\.agent-rishi\\wt\\proj\\abcd",
  platform: "win32",
  home: "C:\\Users\\me",
  tempRoots: ["C:\\Users\\me\\AppData\\Local\\Temp"],
  agentRishiHome: "C:\\Users\\me\\.agent-rishi",
  env: {},
};
const posix: RiskContext = {
  cwd: "/home/me/.agent-rishi/wt/proj/abcd",
  platform: "linux",
  home: "/home/me",
  tempRoots: ["/tmp"],
  agentRishiHome: "/home/me/.agent-rishi",
  shell: "posix",
  env: {},
};
const ps: RiskContext = { ...win, shell: "powershell" };
const auto: RiskContext = { ...win, shell: "auto" };

const levels = (command: string, ctx: RiskContext) => {
  const risk = classifyCommand(command, ctx);
  return `${levelAllows("auto", risk) ? "-" : "auto"}/${levelAllows("full", risk) ? "-" : "full"}`;
};

const TOKEN = "C:\\Users\\me\\.agent-rishi\\runner\\runner.json";

describe("Windows device paths", () => {
  it("name the drive path or share after their prefix", () => {
    expect(fromDevicePath("\\\\?\\C:\\x")).toBe("C:\\x");
    expect(fromDevicePath("\\\\.\\c:\\x")).toBe("c:\\x");
    expect(fromDevicePath("//?/C:/x")).toBe("C:/x");
    expect(fromDevicePath("\\??\\C:\\x")).toBe("C:\\x");
    expect(fromDevicePath("\\\\?\\C:")).toBe("C:");
    expect(fromDevicePath("\\\\?\\UNC\\server\\share\\x")).toBe("\\\\server\\share\\x");
    expect(fromDevicePath("\\\\.\\pipe\\x")).toBe("\\\\.\\pipe\\x");
    expect(fromDevicePath("\\\\server\\share")).toBe("\\\\server\\share");
  });

  it("reach Agent Rishi's credentials and home at every level", () => {
    const p = new ClaudePolicy("full", win);
    for (const prefix of ["\\\\?\\", "\\\\.\\", "\\??\\"]) {
      for (const tool of ["Read", "Write"]) {
        expect(p.gate(tool, { file_path: `${prefix}${TOKEN}` }), `${tool} ${prefix}`).toMatchObject(
          { ask: true, action: "secrets" },
        );
      }
    }
    const other = "//?/C:/Users/me/.agent-rishi/wt/proj/other/x.ts";
    expect(p.gate("Read", { file_path: other })).toMatchObject({ ask: true, action: "secrets" });
    for (const ctx of [ps, auto]) {
      for (const command of [
        `cat "\\\\?\\${TOKEN}"`,
        `Get-Content '\\\\?\\${TOKEN}'`,
        `type \\\\.\\${TOKEN}`,
      ]) {
        expect(classifyCommand(command, ctx), command).toMatchObject({ agentRishi: true });
      }
    }
  });

  it("in the session's own worktree are ordinary", () => {
    const p = new ClaudePolicy("full", win);
    const file_path = "\\\\?\\C:\\Users\\me\\.agent-rishi\\wt\\proj\\abcd\\src\\x.ts";
    expect(p.gate("Write", { file_path })).toEqual({ ask: false });
    expect(p.gate("Read", { file_path })).toEqual({ ask: false });
  });
});

describe("PowerShell's own values in a path", () => {
  it("are only known as a whole word", () => {
    for (const command of [
      'rm -rf "$null/home/me/.agent-rishi"',
      'rm -rf "$true/home/me/.agent-rishi/wt"',
      'echo x > "$false/etc/x"',
      'rm -rf "$_/etc"',
      'rm -rf "src/$null/../../x"',
      'rm -rf ".$null./x"',
    ]) {
      expect(levels(command, posix), command).toBe("auto/full");
    }
    for (const command of [
      'Remove-Item -Recurse "$null\\Users\\me\\.agent-rishi"',
      'Remove-Item -Recurse "src\\$null\\..\\..\\x"',
    ]) {
      expect(levels(command, ps), command).toBe("auto/full");
    }
  });

  it("still stand for themselves as a whole word", () => {
    for (const command of [
      "pnpm test > $null",
      "Get-ChildItem *.log | ForEach-Object { Remove-Item $_ }",
      "Get-ChildItem *.log | ForEach-Object { Remove-Item $_.FullName }",
      "Remove-Item dist -Recurse -Force:$true",
    ]) {
      expect(levels(command, ps), command).toBe("-/-");
    }
  });
});
