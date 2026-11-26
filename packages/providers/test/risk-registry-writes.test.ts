import { describe, expect, it } from "vitest";
import { classifyCommand, classifyWrite, type RiskContext } from "../src/policy/risk";

/**
 * Writes to the Windows registry and to files outside the worktree made by PowerShell's item
 * cmdlets, `reg`, `regedit`, `setx` and `[Environment]::SetEnvironmentVariable` (#533). At Auto a
 * write outside the worktree asks (§11.2), like `Set-Content C:\Windows\x.txt` and
 * `Remove-Item HKCU:\Software\Foo` already did. Writes in the worktree or temp, and to the shell's
 * own `Env:`, `Variable:`, `Function:` and `Alias:` drives, still run.
 */

const win: RiskContext = {
  cwd: "C:\\work\\repo",
  platform: "win32",
  home: "C:\\Users\\me",
  extraRoots: ["D:\\shared"],
  tempRoots: ["C:\\Users\\me\\AppData\\Local\\Temp"],
};
/** PowerShell, cmd (the shell unknown: `auto`) and Git Bash on Windows. */
const ps: RiskContext = { ...win, shell: "powershell" };
const gitBash: RiskContext = { ...win, shell: "posix" };

const action = (command: string, ctx: RiskContext) => {
  const r = classifyCommand(command, ctx);
  return r.risky ? r.action : null;
};
const reason = (command: string, ctx: RiskContext) => {
  const r = classifyCommand(command, ctx);
  return r.risky ? r.reason : null;
};

describe("registry writes (#533)", () => {
  it("asks when reg adds, imports, copies, restores or loads registry keys", () => {
    for (const cmd of [
      "reg add HKCU\\Software\\Foo /v Bar /d 1 /f",
      "reg add HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run /v x /d C:\\x.exe /f",
      "reg.exe add HKLM\\SOFTWARE\\Foo /f",
      "REG ADD HKCU\\Software\\Foo",
      "reg import C:\\x\\evil.reg",
      "reg import evil.reg",
      "reg copy HKCU\\Software\\A HKCU\\Software\\B /s /f",
      "reg restore HKCU\\Software\\Foo foo.hiv",
      "reg load HKU\\Temp C:\\x\\ntuser.dat",
      "reg unload HKU\\Temp",
      "regedit /s C:\\x\\evil.reg",
      "regedit.exe evil.reg",
    ]) {
      expect(action(cmd, win), cmd).toBe("outside_worktree");
      expect(action(cmd, ps), `${cmd} (PowerShell)`).toBe("outside_worktree");
    }
    for (const cmd of [
      "reg add 'HKCU\\Software\\Foo' //v Bar //d 1 //f",
      "reg import /c/x/evil.reg",
      "regedit //s evil.reg",
      "cmd //c reg add HKCU\\\\Software\\\\Foo //f",
    ]) {
      expect(action(cmd, gitBash), `${cmd} (Git Bash)`).toBe("outside_worktree");
    }
    expect(reason("reg add HKCU\\Software\\Foo /v Bar /d 1 /f", win)).toBe(
      "Writes HKCU\\Software\\Foo to the registry",
    );
    expect(reason("reg copy HKCU\\Software\\A HKCU\\Software\\B /s", win)).toBe(
      "Writes HKCU\\Software\\B to the registry",
    );
    expect(reason("reg import C:\\x\\evil.reg", win)).toBe(
      "Imports C:\\x\\evil.reg into the registry",
    );
    // `reg delete` moved here from the deletes and keeps its reason.
    expect(reason("reg delete HKCU\\Software\\Foo /f", win)).toBe(
      "Deletes HKCU\\Software\\Foo from the registry",
    );
  });

  it("asks when a PowerShell item cmdlet writes a registry key, value or certificate", () => {
    for (const cmd of [
      "Set-ItemProperty HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Run -Name x -Value C:\\x.exe",
      "Set-ItemProperty -Name x -Value C:\\x.exe -Path HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Run",
      "Set-ItemProperty -Path HKCU:\\Software\\Foo -Name Bar -Value 1",
      "Set-ItemProperty -Path:HKCU:\\Software\\Foo -Name Bar -Value 1",
      "Set-ItemProperty -LiteralPath HKCU:\\Software\\Foo -Name Bar -Value 1",
      "Set-ItemProperty Registry::HKEY_CURRENT_USER\\Software\\Foo -Name Bar -Value 1",
      "sp HKCU:\\Software\\Foo -Name Bar -Value 1",
      "New-Item HKCU:\\Software\\Foo -Force",
      "New-Item -Path HKCU:\\Software -Name Foo",
      "New-Item -Path HKCU:\\Software\\Foo -ItemType Directory",
      "ni HKCU:\\Software\\Foo",
      "mkdir HKCU:\\Software\\Foo",
      "New-ItemProperty -Path HKCU:\\Software\\Foo -Name Bar -Value 1 -PropertyType DWord",
      "New-ItemProperty HKLM:\\SOFTWARE\\Foo -Name Bar -Value 1",
      "Set-Item HKCU:\\Software\\Foo -Value x",
      "si HKCU:\\Software\\Foo -Value x",
      "Clear-Item HKCU:\\Software\\Foo",
      "Clear-ItemProperty HKCU:\\Software\\Foo -Name Bar",
      "Rename-Item HKCU:\\Software\\Foo Bar",
      "Rename-ItemProperty HKCU:\\Software\\Foo -Name Bar -NewName Baz",
      "Copy-ItemProperty -Path HKCU:\\Software\\A -Destination HKCU:\\Software\\B -Name Bar",
      "Copy-ItemProperty HKCU:\\Software\\A HKCU:\\Software\\B Bar",
      "Move-ItemProperty HKCU:\\Software\\A HKCU:\\Software\\B -Name Bar",
      "Copy-Item HKCU:\\Software\\A HKCU:\\Software\\B -Recurse",
      "Set-ItemProperty Cert:\\CurrentUser\\My\\ABC123 -Name FriendlyName -Value x",
      // A pipe hands the cmdlet the key it writes.
      "Get-Item HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Run | New-ItemProperty -Name x -Value C:\\x.exe",
      // .NET calls in an expression.
      "[Environment]::SetEnvironmentVariable('PATH', 'C:\\evil', 'User')",
      "[Microsoft.Win32.Registry]::SetValue('HKEY_CURRENT_USER\\Software\\Foo', 'Bar', 1)",
      "[Microsoft.Win32.Registry]::CurrentUser.CreateSubKey('Software\\Foo')",
    ]) {
      expect(action(cmd, ps), cmd).toBe("outside_worktree");
      expect(action(cmd, win), `${cmd} (shell unknown)`).toBe("outside_worktree");
    }
    for (const cmd of [
      "powershell -Command 'Set-ItemProperty HKCU:\\Software\\Foo -Name x -Value 1'",
      "pwsh -NoProfile -c 'New-Item HKCU:\\Software\\Foo -Force'",
    ]) {
      expect(action(cmd, gitBash), `${cmd} (Git Bash)`).toBe("outside_worktree");
    }
    expect(
      classifyCommand(
        "Set-ItemProperty HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Run -Name x -Value C:\\x.exe",
        ps,
      ),
    ).toEqual({
      risky: true,
      action: "outside_worktree",
      reason:
        "Writes HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Run, outside the worktree",
    });
    expect(reason("New-Item -Path HKCU:\\Software -Name Foo", ps)).toBe(
      "Writes HKCU:\\Software\\Foo, outside the worktree",
    );
  });

  it("asks when setx or SetEnvironmentVariable changes the environment for good", () => {
    for (const cmd of ["setx PATH C:\\evil", "setx FOO bar /m", "setx.exe FOO bar"]) {
      expect(action(cmd, win), cmd).toBe("outside_worktree");
      expect(action(cmd, ps), `${cmd} (PowerShell)`).toBe("outside_worktree");
    }
    expect(action("setx PATH 'C:\\evil' //m", gitBash)).toBe("outside_worktree");
    for (const cmd of [
      "[Environment]::SetEnvironmentVariable('PATH', 'C:\\evil', 'User')",
      '[System.Environment]::SetEnvironmentVariable("FOO","bar",[System.EnvironmentVariableTarget]::Machine)',
      "[Environment]::SetEnvironmentVariable('FOO', ($env:PATH + ';C:\\x'), [EnvironmentVariableTarget]::User)",
      "$null = [Environment]::SetEnvironmentVariable('FOO', 'bar', $target)",
    ]) {
      expect(action(cmd, ps), cmd).toBe("outside_worktree");
    }
    expect(reason("setx PATH C:\\evil", win)).toBe(
      "Sets the environment variable PATH for good for the user",
    );
    expect(reason("setx FOO bar /M", win)).toBe(
      "Sets the environment variable FOO for good for the whole system",
    );
    expect(
      reason(
        '[System.Environment]::SetEnvironmentVariable("FOO","bar",[System.EnvironmentVariableTarget]::Machine)',
        ps,
      ),
    ).toBe("Sets the environment variable FOO for good for the whole system");
  });

  it("still runs reads of the registry, exports into the worktree and the running shell's environment", () => {
    for (const cmd of [
      "reg query HKCU\\Software\\Foo",
      "reg query HKCU\\Software\\Foo /s /v Bar",
      "reg export HKCU\\Software\\Foo out.reg /y",
      "reg save HKCU\\Software\\Foo C:\\Users\\me\\AppData\\Local\\Temp\\foo.hiv",
      "regedit /e out.reg HKEY_CURRENT_USER\\Software\\Foo",
      "reg /?",
      "setx /?",
      "Get-ItemProperty HKCU:\\Software\\Foo",
      "Get-Item HKCU:\\Software\\Foo",
      "Get-ChildItem HKCU:\\Software -Recurse",
      "Test-Path HKCU:\\Software\\Foo",
      "[Environment]::SetEnvironmentVariable('FOO', 'bar')",
      "[Environment]::SetEnvironmentVariable('FOO', 'bar', 'Process')",
      "[Environment]::SetEnvironmentVariable('FOO', 'bar', [EnvironmentVariableTarget]::Process)",
      "[Environment]::GetEnvironmentVariable('PATH', 'User')",
      "[Microsoft.Win32.Registry]::GetValue('HKEY_CURRENT_USER\\Software\\Foo', 'Bar', $null)",
      // A call quoted in text is data.
      "gh pr create --title x --body \"Asks for [Environment]::SetEnvironmentVariable('X', 'y', 'User')\"",
    ]) {
      expect(action(cmd, ps), cmd).toBeNull();
    }
    expect(action("reg query HKCU\\\\Software\\\\Foo //s", gitBash)).toBeNull();
    // An export is a file write, judged like one.
    expect(reason("reg export HKCU\\Software\\Foo C:\\Users\\me\\foo.reg", win)).toBe(
      "Writes C:\\Users\\me\\foo.reg, outside the worktree",
    );
    expect(action("regedit /e C:\\Users\\me\\foo.reg", win)).toBe("outside_worktree");
  });
});

describe("New-Item and Set-Item writing files (#533)", () => {
  it("asks when New-Item creates a file outside the worktree", () => {
    for (const cmd of [
      "New-Item C:\\Windows\\x.txt -ItemType File -Value hi",
      "New-Item -Path C:\\Users\\me\\profile.ps1 -Value hi -Force",
      "New-Item -Path:C:\\Users\\me\\x.txt -Value hi",
      "New-Item -Value hi -ItemType File C:\\Users\\me\\x.txt",
      "ni C:\\Users\\me\\x.txt -Value hi",
      "New-Item -ItemType File -Path ~\\Documents\\PowerShell\\Microsoft.PowerShell_profile.ps1",
      "New-Item -Path C:\\Users\\me -Name x.txt -Value hi",
      "New-Item -ItemType SymbolicLink -Path C:\\Users\\me\\x -Target C:\\work\\repo\\x",
      "Set-Item C:\\Users\\me\\x.txt -Value hi",
      "Clear-Content C:\\Users\\me\\notes.txt",
      "Rename-Item C:\\Users\\me\\x.txt y.txt",
      "ren C:\\Users\\me\\x.txt y.txt",
      "New-Item FileSystem::C:\\Users\\me\\x.txt -Value hi",
      "cd C:\\Users\\me; New-Item x.txt -Value hi",
    ]) {
      expect(action(cmd, ps), cmd).toBe("outside_worktree");
    }
    expect(classifyCommand("New-Item C:\\Windows\\x.txt -ItemType File -Value hi", ps)).toEqual({
      risky: true,
      action: "outside_worktree",
      reason: "Writes C:\\Windows\\x.txt, outside the worktree",
    });
  });

  it("still runs New-Item and Set-Item in the worktree, temp and the shell's own drives", () => {
    for (const cmd of [
      "New-Item src\\x.ts -ItemType File",
      "New-Item -ItemType File -Name x.ts -Path src",
      "New-Item -Name notes.md -Value hi",
      "New-Item x.ts -Value '/* comment */'",
      "New-Item -Path C:\\work\\repo\\notes.md -Value hi",
      "New-Item -Path $env:TEMP\\probe.txt -Value 1",
      "New-Item -Path Temp:\\probe.txt -Value 1",
      "New-Item -Path D:\\shared\\x.txt -Value 1",
      "Set-ItemProperty src\\x.txt -Name IsReadOnly -Value $true",
      "Rename-Item src\\a.ts b.ts",
      "New-Item Env:FOO -Value bar",
      "Set-Item Env:FOO bar",
      'Set-Item -Path Env:PATH -Value "$env:PATH;C:\\tools"',
      "Set-Item Variable:x 1",
      "Set-Item Function:prompt { 'PS> ' }",
      "New-Item Alias:ll -Value Get-ChildItem",
      "Set-Content Env:FOO bar",
      // A folder in the worktree or temp.
      "New-Item -ItemType Directory -Path dist -Force",
      "New-Item -ItemType Directory -Path $env:TEMP\\scratch",
      "mkdir src\\scratch",
    ]) {
      expect(action(cmd, ps), cmd).toBeNull();
    }
    // A folder outside the worktree is a write there too (#614).
    for (const cmd of [
      "New-Item -ItemType Directory -Path C:\\Users\\me\\scratch",
      "mkdir C:\\Users\\me\\scratch",
    ]) {
      expect(action(cmd, ps), cmd).toBe("outside_worktree");
    }
    // Creating an env file in the worktree reads nothing (as with Set-Content).
    expect(action("New-Item .env -Value PORT=3000", ps)).toBeNull();
  });

  it("still asks when Rename-Item moves a secrets file, which hands it over under a new name", () => {
    for (const cmd of [
      "Rename-Item .env x.txt",
      "Rename-Item -Path .env -NewName x.txt",
      "rni .env x.txt",
      "Rename-Item .env.local notes.md",
      "Rename-Item secrets\\id_rsa key.txt",
      "Rename-Item C:\\work\\repo\\.env x.txt",
      "Rename-Item .env notes.txt; Get-Content notes.txt",
    ]) {
      expect(action(cmd, ps), cmd).toBe("secrets");
    }
    // cmd's `ren`, like `mv .env x.txt` and `Move-Item .env x.txt`.
    expect(action("ren .env x.txt", win)).toBe("secrets");
    expect(classifyCommand("Rename-Item .env x.txt", ps)).toEqual({
      risky: true,
      action: "secrets",
      reason: "Accesses the secrets file .env",
    });
  });
});

describe("relative paths after cd into a PowerShell drive (#533)", () => {
  it("asks when a relative delete or write follows a cd into the registry", () => {
    for (const cmd of [
      "cd HKCU:\\Software; Remove-Item Foo -Recurse",
      "Set-Location HKCU:\\Software; Remove-Item Foo -Recurse",
      "Set-Location -Path HKLM:\\SOFTWARE && Remove-Item .\\Foo",
      "Push-Location HKCU:\\Software; Remove-Item Foo -Recurse",
      "sl Registry::HKEY_CURRENT_USER\\Software; ri Foo",
      "Set-Location HKLM:\\; New-Item Foo",
      "cd HKCU:\\Software; New-Item Foo",
      "cd HKCU:\\Software\\Foo; Set-ItemProperty . -Name Bar -Value 1",
      "cd HKCU:\\Software\\Foo; Set-ItemProperty -Name Bar -Value 1",
      "cd HKCU:\\Software; cd Foo; Remove-ItemProperty . -Name Bar",
      "cd HKCU:\\Software; Copy-Item Foo Bar -Recurse",
      "cd HKCU:\\Software; Get-ChildItem Foo | Remove-Item -Recurse",
      "cd Cert:\\CurrentUser\\My; Remove-Item ABC123",
    ]) {
      expect(action(cmd, ps), cmd).toBe("outside_worktree");
    }
    expect(classifyCommand("cd HKCU:\\Software; Remove-Item Foo -Recurse", ps)).toEqual({
      risky: true,
      action: "outside_worktree",
      reason: "Deletes Foo, outside the worktree",
    });
  });

  it("still runs relative deletes after a cd into the shell's own drives or back to a folder", () => {
    for (const cmd of [
      "cd Env:; Remove-Item FOO",
      "Set-Location Variable:; Remove-Item x",
      "cd HKCU:\\Software; cd C:\\work\\repo; Remove-Item dist -Recurse",
      "cd HKCU:\\Software; cd ~\\..\\..\\work\\repo; Remove-Item dist -Recurse",
      "cd Temp:\\; Remove-Item probe -Recurse",
      "cd HKCU:\\Software; Get-ChildItem",
      // A cd in a subshell doesn't leak out of it.
      "(cd HKCU:\\Software); Remove-Item dist -Recurse",
    ]) {
      expect(action(cmd, ps), cmd).toBeNull();
    }
  });

  it("reads a colon as part of a file name elsewhere than Windows", () => {
    const posix: RiskContext = { cwd: "/work/repo", platform: "linux", home: "/home/me" };
    expect(action("cd build:cache && rm -rf x", posix)).toBeNull();
    expect(classifyWrite("build:cache/x", posix)).toEqual({ risky: false });
  });
});
