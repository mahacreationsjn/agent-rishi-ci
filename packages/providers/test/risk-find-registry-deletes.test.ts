import { describe, expect, it } from "vitest";
import { classifyCommand, type RiskContext } from "../src/policy/risk";

/**
 * Deletes outside the worktree that `find`/`fd` run on what they find, and deletes of registry
 * keys and other PowerShell drives that are never in the worktree (#518). Both must ask at Auto
 * (§11.2) like `rm -rf ~/x` and `find X | xargs rm` already do. Deletes in the worktree or temp,
 * and of the shell's own `Env:`, `Variable:`, `Function:` and `Alias:` drives, still run.
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
/** Git Bash on Windows. */
const gitBash: RiskContext = { ...win, shell: "posix" };

const action = (command: string, ctx: RiskContext) => {
  const r = classifyCommand(command, ctx);
  return r.risky ? r.action : null;
};

describe("find and fd deleting what they find (#518)", () => {
  it("asks when find deletes outside the worktree", () => {
    for (const cmd of [
      "find ~/projects -name '*.log' -delete",
      "find /home/me/Documents -type f -exec rm {} \\;",
      "find ../other -name '*.o' -exec rm -f {} +",
      "find -L ~/old -exec rm -rf {} +",
      "find ~/old -type d -execdir rm -rf {} \\;",
      "find ~/old -ok rm {} \\;",
      "find ~/old -name x -exec unlink {} \\;",
      "find ~/old -exec shred -u {} \\;",
      "find ~/old -exec rmdir {} \\;",
      "find / -name core -delete",
      // No path: the current directory, which a cd moved out of the worktree.
      "cd ~ && find -name '*.log' -delete",
      "cd /home/me && find . -exec rm {} +",
    ]) {
      expect(action(cmd, posix), cmd).toBe("outside_worktree");
    }
    expect(action("find /c/Users/me/Documents -type f -exec rm {} \\;", gitBash)).toBe(
      "outside_worktree",
    );
    expect(classifyCommand("find ~/projects -name '*.log' -delete", posix)).toEqual({
      risky: true,
      action: "outside_worktree",
      reason: "Deletes what find finds in ~/projects, outside the worktree",
    });
    // The paths the delete command names itself count too.
    expect(classifyCommand("find . -name x -exec rm -rf /var/cache/{} \\;", posix)).toEqual({
      risky: true,
      action: "outside_worktree",
      reason: "Deletes /var/cache/{}, outside the worktree",
    });
  });

  it("asks when fd runs a delete on what it finds outside the worktree", () => {
    for (const cmd of [
      "fd . ~/old -x rm",
      "fd -e log . /home/me/old -X rm -rf",
      "fd -t f . ~/old --exec rm {}",
      // `-x` takes the words up to `;`; the pattern and paths may follow.
      "fd -HIx rm \\; . ~/old",
      "cd ~ && fd -X rm -rf",
    ]) {
      expect(action(cmd, posix), cmd).toBe("outside_worktree");
    }
  });

  it("still runs find and fd deletes of the worktree and temp, and finds that delete nothing", () => {
    for (const cmd of [
      "find . -name '*.tmp' -delete",
      "find -name '*.tmp' -delete",
      "find dist -type f -exec rm {} +",
      "find /work/repo/build -exec rm -rf {} \\;",
      "find /tmp/agent-rishi-probe -delete",
      "fd -e tmp -X rm",
      "fd . dist -x rm",
      // Not deletes.
      "find ~/projects -name '*.log'",
      "find ~/projects -name '*.ts' -exec grep -l foo {} +",
      "fd . ~/projects -x wc -l",
    ]) {
      expect(action(cmd, posix), cmd).toBeNull();
    }
  });
});

describe("deletes of registry keys and other non-filesystem drives (#518)", () => {
  it("asks when Remove-Item deletes a registry key", () => {
    for (const cmd of [
      "Remove-Item HKCU:\\Software\\Foo -Recurse",
      "Remove-Item -Path HKCU:\\Software\\Foo -Recurse -Force",
      "Remove-Item -Path:HKLM:\\SOFTWARE\\Foo -Recurse",
      "Remove-Item -LiteralPath:HKCU:\\Software\\Foo",
      "Remove-Item 'HKCU:\\Software\\My App' -Recurse",
      "Remove-Item Registry::HKEY_CURRENT_USER\\Software\\Foo -Recurse",
      "Remove-Item Microsoft.PowerShell.Core\\Registry::HKEY_LOCAL_MACHINE\\SOFTWARE\\Foo",
      "ri hkcu:\\Software\\Foo -Recurse",
      "del HKCU:\\Software\\Foo",
      "rd HKCU:\\Software\\Foo -Recurse",
      "Remove-Item Cert:\\CurrentUser\\My\\ABC123",
      "Get-ChildItem HKCU:\\Software\\Foo | Remove-Item -Recurse",
      "Remove-ItemProperty HKCU:\\Software\\Foo -Name Bar",
      "Remove-ItemProperty -Path HKCU:\\Software\\Foo -Name Bar",
      "rp HKCU:\\Software\\Foo -Name Bar",
    ]) {
      expect(action(cmd, ps), cmd).toBe("outside_worktree");
      expect(action(cmd, win), `${cmd} (shell unknown)`).toBe("outside_worktree");
    }
    expect(classifyCommand("Remove-Item HKCU:\\Software\\Foo -Recurse", ps)).toEqual({
      risky: true,
      action: "outside_worktree",
      reason: "Deletes HKCU:\\Software\\Foo, outside the worktree",
    });
  });

  it("reads FileSystem:: paths and the Temp: drive as the folders they name", () => {
    expect(action("Remove-Item FileSystem::C:\\Users\\me\\x -Recurse", ps)).toBe(
      "outside_worktree",
    );
    for (const cmd of [
      "Remove-Item Microsoft.PowerShell.Core\\FileSystem::C:\\work\\repo\\dist -Recurse",
      "Remove-Item Temp:\\agent-rishi-probe -Recurse",
    ]) {
      expect(action(cmd, ps), cmd).toBeNull();
    }
    // Elsewhere than Windows a colon is part of a file name.
    expect(action("rm -rf build:cache", posix)).toBeNull();
  });

  it("asks when reg delete removes a registry key or value", () => {
    for (const cmd of [
      "reg delete HKCU\\Software\\Foo /f",
      "reg delete HKEY_LOCAL_MACHINE\\SOFTWARE\\Foo /v Bar /f",
      "reg.exe delete HKCU\\Software\\Foo /va /f",
      "REG DELETE HKCU\\Software\\Foo",
    ]) {
      // cmd runs with the shell unknown (`auto`).
      expect(action(cmd, win), cmd).toBe("outside_worktree");
      expect(action(cmd, ps), `${cmd} (PowerShell)`).toBe("outside_worktree");
    }
    expect(classifyCommand("reg delete HKCU\\Software\\Foo /f", win)).toEqual({
      risky: true,
      action: "outside_worktree",
      reason: "Deletes HKCU\\Software\\Foo from the registry",
    });
    // Reading the registry is not a delete.
    expect(action("reg query HKCU\\Software\\Foo", win)).toBeNull();
  });

  it("still runs deletes on the shell's own drives", () => {
    for (const cmd of [
      "Remove-Item Env:\\FOO",
      "Remove-Item env:AGENT_RISHI_PROBE",
      "Remove-Item -Path Env:FOO",
      "Remove-Item Variable:x",
      "Remove-Item variable:\\x -Force",
      "Remove-Item Function:\\prompt",
      "Remove-Item Alias:ll",
      "ri env:FOO",
      "Get-ChildItem env: | Where-Object Name -like 'AGENT_RISHI*' | Remove-Item",
    ]) {
      expect(action(cmd, ps), cmd).toBeNull();
    }
  });
});
