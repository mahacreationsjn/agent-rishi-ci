import { describe, expect, it } from "vitest";
import { classifyCommand, type RiskContext } from "../src/policy/risk";

/**
 * Deletes that take their paths from a pipeline (#449). `Remove-Item` with no path of its own
 * removes whatever the command before it lists, so `Get-ChildItem C:\Users | Remove-Item -Recurse`
 * deletes outside the worktree just like `Remove-Item -Recurse C:\Users\*` does, and must ask at
 * Auto the same way; so must the same delete written as `ForEach-Object { Remove-Item $_ }`, or
 * as `… | xargs rm`. A listing of the worktree, an extra root or temp piped into a delete still
 * runs, and so does clearing environment variables (`Get-ChildItem env: | Remove-Item`, #422).
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
  extraRoots: ["D:\\shared"],
  tempRoots: ["C:\\Users\\me\\AppData\\Local\\Temp"],
};
const ps: RiskContext = { ...win, shell: "powershell" };

const action = (command: string, ctx: RiskContext) => {
  const r = classifyCommand(command, ctx);
  return r.risky ? r.action : null;
};

describe("deletes fed by a pipeline (#449)", () => {
  it("asks when a listing outside the worktree is piped into Remove-Item", () => {
    for (const cmd of [
      "Get-ChildItem C:\\Users | Remove-Item -Recurse",
      "Get-ChildItem C:\\Users | Remove-Item -Recurse -Force",
      "Get-ChildItem -Path C:\\Users\\me\\Documents -Recurse | Remove-Item -Force",
      "gci ..\\other | ri -Recurse",
      "Get-ChildItem $home\\Documents -Filter *.log | Remove-Item",
      "Get-ChildItem C:\\ -Directory | Where-Object { $_.Name -like 'old*' } | Remove-Item -Recurse",
      "Get-Item C:\\Windows\\Temp\\x | Remove-Item -Recurse",
      "ls C:\\Users\\me | rm -Recurse",
      "Get-ChildItem C:\\Users | ForEach-Object { Remove-Item $_.FullName -Recurse }",
      "gci C:\\Users\\me -Recurse | % { Remove-Item $_ -Force }",
    ]) {
      expect(action(cmd, ps), cmd).toBe("outside_worktree");
      expect(action(cmd, win), `${cmd} (shell unknown)`).toBe("outside_worktree");
    }
    expect(classifyCommand("Get-ChildItem C:\\Users | Remove-Item -Recurse", ps)).toEqual({
      risky: true,
      action: "outside_worktree",
      reason: "Deletes what a pipe lists from C:\\Users, outside the worktree",
    });
  });

  it("reads the listing's paths the way PowerShell binds them", () => {
    for (const cmd of [
      // A list of paths, a bound -Path, and a listing of a folder a cd moved to.
      "Get-ChildItem dist,C:\\Users\\me | Remove-Item -Recurse",
      "Get-ChildItem -Path:C:\\Users\\me -Recurse | Remove-Item",
      "Set-Location C:\\Users\\me; Get-ChildItem -Recurse | Remove-Item -Force",
      "Remove-Item -Path:C:\\Users\\me\\x -Recurse",
      "Remove-Item dist,C:\\Users\\me\\x",
    ]) {
      expect(action(cmd, ps), cmd).toBe("outside_worktree");
    }
    // A filter's pattern is not a path.
    expect(action("Get-ChildItem -Recurse -Filter \\*.log | Remove-Item", ps)).toBeNull();
  });

  it("asks when names from outside the worktree are piped into xargs rm", () => {
    for (const cmd of [
      "ls / | xargs rm -rf",
      "find ~ -name '*.log' | xargs rm",
      "find -L ../other -name '*.log' | xargs rm",
      "find ../other -type d -print0 | xargs -0 rm -rf",
      "cd ~ && ls | xargs rm",
      // xargs's own paths are checked too.
      "find . -name '*.tmp' | xargs -I{} rm -rf /var/cache/{}",
      "xargs rm -rf ~/projects < list.txt",
    ]) {
      expect(action(cmd, posix), cmd).toBe("outside_worktree");
    }
  });

  it("still runs piped deletes of the worktree, extra roots, temp and environment variables", () => {
    for (const cmd of [
      "Get-ChildItem dist | Remove-Item -Recurse",
      "Get-ChildItem -Recurse -Filter *.tmp | Remove-Item",
      "Get-ChildItem .\\build -Directory | Remove-Item -Recurse -Force",
      "Get-ChildItem D:\\shared\\cache | Remove-Item -Recurse",
      "Get-ChildItem $env:TEMP\\agent-rishi-probe-* | Remove-Item -Recurse",
      "Get-ChildItem dist | ForEach-Object { Remove-Item $_.FullName -Recurse }",
      "Get-ChildItem env: | Where-Object Name -like 'AGENT_RISHI*' | Remove-Item",
      "Get-ChildItem Env:AGENT_RISHI* | Remove-Item",
    ]) {
      expect(action(cmd, ps), cmd).toBeNull();
    }
    for (const cmd of [
      "find . -name '*.tmp' | xargs rm",
      "find dist -type f -print0 | xargs -0 rm -f",
      "ls /tmp/agent-rishi-probe | xargs rm",
    ]) {
      expect(action(cmd, posix), cmd).toBeNull();
    }
  });
});
