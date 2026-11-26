import { describe, expect, it } from "vitest";
import { classifyCommand, type RiskContext } from "../src/policy/risk";

/**
 * Three ways PowerShell commands got around the outside-the-worktree checks at Auto (#541, §11.2):
 * `Start-Process` (and its aliases `saps` and `start`) running reg, regedit, setx, a delete or an
 * inline script; item cmdlets fed by a pipe whose value is a script block
 * (`… | Rename-Item -NewName { … }`); and `Pop-Location`/`popd`, which never restored the location
 * before a `Push-Location`/`pushd`.
 */

const win: RiskContext = {
  cwd: "C:\\work\\repo",
  platform: "win32",
  home: "C:\\Users\\me",
  extraRoots: ["D:\\shared"],
  tempRoots: ["C:\\Users\\me\\AppData\\Local\\Temp"],
};
/** PowerShell, and the shell unknown (`auto`) on Windows. */
const ps: RiskContext = { ...win, shell: "powershell" };

const action = (command: string, ctx: RiskContext) => {
  const r = classifyCommand(command, ctx);
  return r.risky ? r.action : null;
};
const reason = (command: string, ctx: RiskContext) => {
  const r = classifyCommand(command, ctx);
  return r.risky ? r.reason : null;
};

describe("Start-Process (#541)", () => {
  it("asks when Start-Process runs a registry write, a permanent env change or a delete", () => {
    for (const cmd of [
      "Start-Process -FilePath reg.exe -ArgumentList 'add','HKCU\\Software\\Foo','/f'",
      "Start-Process regedit -ArgumentList '/s','x.reg'",
      "saps setx -ArgumentList 'PATH C:\\x'",
      "start reg -ArgumentList 'add HKCU\\Software\\Foo /f'",
      "Start-Process powershell -ArgumentList '-Command','Remove-Item C:\\Users\\me\\x -Recurse'",
      "Start-Process cmd -ArgumentList '/c rd /s /q C:\\Users\\me\\x'",
      "Start-Process pwsh -ArgumentList '-c \"Remove-Item ~\\x -Recurse\"'",
    ]) {
      expect(action(cmd, ps), cmd).toBe("outside_worktree");
      expect(action(cmd, win), `${cmd} (shell unknown)`).toBe("outside_worktree");
    }
  });

  it("names what the started command writes or deletes", () => {
    expect(
      reason("Start-Process -FilePath reg.exe -ArgumentList 'add','HKCU\\Software\\Foo','/f'", ps),
    ).toBe("Writes HKCU\\Software\\Foo to the registry");
    expect(reason("start reg -ArgumentList 'add HKCU\\Software\\Foo /f'", win)).toBe(
      "Writes HKCU\\Software\\Foo to the registry",
    );
    expect(reason("Start-Process regedit -ArgumentList '/s','x.reg'", ps)).toBe(
      "Imports x.reg into the registry",
    );
    expect(reason("saps setx -ArgumentList 'PATH C:\\x'", ps)).toBe(
      "Sets the environment variable PATH for good for the user",
    );
    expect(
      reason(
        "Start-Process powershell -ArgumentList '-Command','Remove-Item C:\\Users\\me\\x -Recurse'",
        ps,
      ),
    ).toBe("Deletes C:\\Users\\me\\x, outside the worktree");
    expect(reason("Start-Process cmd -ArgumentList '/c rd /s /q C:\\Users\\me\\x'", ps)).toBe(
      "Deletes C:\\Users\\me\\x, outside the worktree",
    );
  });

  it("reads Start-Process's parameters the way PowerShell binds them", () => {
    for (const cmd of [
      // Named or positional, in any order, with switches and common parameters around them.
      "Start-Process reg 'add HKCU\\Software\\Foo /f'",
      "Start-Process -ArgumentList 'add HKCU\\Software\\Foo /f' -FilePath reg",
      "Start-Process -Wait -NoNewWindow -FilePath reg -ArgumentList 'add HKCU\\Software\\Foo /f'",
      "Start-Process -ErrorAction Stop reg -Args 'add HKCU\\Software\\Foo /f' -PassThru",
      "Start-Process -FilePath:reg -ArgumentList:'add','HKCU\\Software\\Foo'",
      // A list written with spaces, or as an array.
      "Start-Process reg -ArgumentList 'add', 'HKCU\\Software\\Foo', '/f'",
      "Start-Process reg -ArgumentList @('add', 'HKCU\\Software\\Foo', '/f')",
      // A program path, and the call operator around it.
      "Start-Process C:\\Windows\\System32\\reg.exe -ArgumentList 'add HKCU\\Software\\Foo /f'",
      "& Start-Process reg -ArgumentList 'add HKCU\\Software\\Foo /f'",
      // Through an inline script.
      "powershell -Command \"Start-Process reg -ArgumentList 'add HKCU\\Software\\Foo /f'\"",
    ]) {
      expect(action(cmd, ps), cmd).toBe("outside_worktree");
    }
    expect(
      reason("Start-Process -FilePath:reg -ArgumentList:'add','HKCU\\Software\\Foo'", ps),
    ).toBe("Writes HKCU\\Software\\Foo to the registry");
    expect(
      reason("Start-Process reg -ArgumentList @('add', 'HKCU\\Software\\Foo', '/f')", ps),
    ).toBe("Writes HKCU\\Software\\Foo to the registry");
  });

  it("resolves relative paths from -WorkingDirectory", () => {
    expect(
      reason("Start-Process cmd -ArgumentList '/c rd /s /q x' -WorkingDirectory C:\\Users\\me", ps),
    ).toBe("Deletes x, outside the worktree");
    expect(
      action(
        "Start-Process pwsh -ArgumentList '-c','Remove-Item dist -Recurse' -WorkingDirectory ..\\other",
        ps,
      ),
    ).toBe("outside_worktree");
    expect(
      action(
        "Start-Process cmd -ArgumentList '/c rd /s /q dist' -WorkingDirectory C:\\work\\repo\\packages\\x",
        ps,
      ),
    ).toBeNull();
    expect(
      action(
        "cd C:\\Users\\me; Start-Process cmd '/c rd /s /q dist' -WorkingDirectory C:\\work\\repo",
        ps,
      ),
    ).toBeNull();
  });

  it("asks when it runs a program elevated or writes its output outside the worktree", () => {
    expect(classifyCommand("Start-Process powershell -Verb RunAs", ps)).toEqual({
      risky: true,
      action: "other",
      reason: "Runs a command with elevated privileges",
    });
    expect(
      reason(
        "Start-Process pnpm -ArgumentList 'test' -RedirectStandardOutput C:\\Users\\me\\out.txt",
        ps,
      ),
    ).toBe("Writes C:\\Users\\me\\out.txt, outside the worktree");
    expect(
      action("Start-Process pnpm 'test' -RedirectStandardError C:\\Users\\me\\err.txt", ps),
    ).toBe("outside_worktree");
    expect(
      action("Start-Process pnpm 'test' -RedirectStandardOutput out.txt -Wait", ps),
    ).toBeNull();
  });

  it("reads cmd's start too: switches before the program, and a title", () => {
    for (const cmd of [
      "start reg add HKCU\\Software\\Foo /f",
      'start "" reg add HKCU\\Software\\Foo /f',
      'start "Registry" reg add HKCU\\Software\\Foo /f',
      "start /b /wait reg add HKCU\\Software\\Foo /f",
      "start /min cmd /c rd /s /q C:\\Users\\me\\x",
      "cmd /c start /b reg add HKCU\\Software\\Foo /f",
    ]) {
      expect(action(cmd, win), cmd).toBe("outside_worktree");
    }
    expect(action("start /d C:\\Users\\me cmd /c rd /s /q x", win)).toBe("outside_worktree");
    expect(action("start /dC:\\Users\\me cmd /c rd /s /q x", win)).toBe("outside_worktree");
    expect(action("start /d C:\\work\\repo cmd /c rd /s /q dist", win)).toBeNull();
  });

  it("asks exactly as the same command run directly does", () => {
    for (const cmd of [
      "& reg add HKCU\\Software\\Foo /f",
      "cmd /c reg add HKCU\\Software\\Foo /f",
      'powershell -Command "Remove-Item C:\\Users\\me\\x -Recurse"',
    ]) {
      expect(action(cmd, ps), cmd).toBe("outside_worktree");
    }
  });

  it("still opens programs, files and URLs, and runs harmless work, without asking", () => {
    for (const cmd of [
      "Start-Process notepad -ArgumentList 'README.md'",
      "Start-Process notepad README.md",
      "Start-Process https://example.com",
      "Start-Process 'https://github.com/org/repo/pull/1'",
      "Start-Process .",
      "Start-Process explorer .",
      "Start-Process code -ArgumentList '.'",
      "Start-Process pnpm -ArgumentList 'test' -Wait -NoNewWindow",
      "Start-Process -FilePath node -ArgumentList 'server.js' -PassThru",
      "Start-Process reg -ArgumentList 'query HKCU\\Software\\Foo'",
      "Start-Process cmd -ArgumentList '/c rd /s /q dist'",
      "Start-Process powershell -ArgumentList '-Command','Get-ChildItem'",
      "Start-Process 'C:\\Program Files\\Git\\git-bash.exe'",
      "saps notepad",
      "start notepad README.md",
      "start https://example.com",
      "Start-Process -Verb Open README.md",
    ]) {
      expect(action(cmd, ps), cmd).toBeNull();
      expect(action(cmd, win), `${cmd} (shell unknown)`).toBeNull();
    }
  });
});

describe("piped item cmdlets with a script block (#541)", () => {
  it("asks when a listing outside the worktree is renamed, moved or changed with a script block", () => {
    for (const cmd of [
      "Get-ChildItem C:\\Users\\me\\Docs -Filter *.txt | Rename-Item -NewName { $_.Name -replace '.txt','.md' }",
      "Get-ChildItem C:\\Users\\me\\Docs | Rename-Item -NewName { $_.Name + '.bak' }",
      "Get-ChildItem C:\\Users\\me\\Docs | Rename-Item -NewName {$_.Name + '.bak'}",
      "Get-ChildItem C:\\Users\\me\\Docs | Move-Item -Destination { 'C:\\Users\\me\\Old\\' + $_.Name }",
      "Get-ChildItem C:\\Users\\me\\Docs | Set-ItemProperty -Name IsReadOnly -Value { $true }",
      "Get-Item HKCU:\\Software\\Foo | Set-ItemProperty -Name X -Value { 1 }",
      "Get-ChildItem C:\\Users\\me\\Docs | Where-Object { $_.Length -gt 0 } | Rename-Item -NewName { $_.Name + '.old' }",
      // A `;` in the block, which ends the command early.
      'Get-ChildItem C:\\Users\\me\\Docs | Rename-Item -NewName { $n = $_.BaseName; "$n.md" }',
      // A block given as the path works on the piped items.
      "Get-ChildItem C:\\Users\\me\\Docs | Rename-Item -LiteralPath { $_.FullName } -NewName x.bak",
    ]) {
      expect(action(cmd, ps), cmd).toBe("outside_worktree");
      expect(action(cmd, win), `${cmd} (shell unknown)`).toBe("outside_worktree");
    }
    expect(
      reason("Get-ChildItem C:\\Users\\me\\Docs | Rename-Item -NewName { $_.Name + '.bak' }", ps),
    ).toBe("Writes C:\\Users\\me\\Docs, outside the worktree");
    expect(
      reason("Get-ChildItem src | Move-Item -Destination { 'C:\\Users\\me\\Old\\' + $_.Name }", ps),
    ).toBe("Writes C:\\Users\\me\\Old\\, outside the worktree");
    expect(
      action("Get-ChildItem src | Copy-Item -Destination { Join-Path $HOME $_.Name }", ps),
    ).toBe("outside_worktree");
  });

  it("asks for the plain forms, as before", () => {
    for (const cmd of [
      "Get-ChildItem C:\\Users\\me\\Docs | Rename-Item -NewName x.bak",
      "Get-ChildItem C:\\Users\\me\\Docs | Move-Item -Destination C:\\Users\\me\\Old",
      "Get-ChildItem C:\\Users\\me\\Docs | Set-ItemProperty -Name IsReadOnly -Value $true",
    ]) {
      expect(action(cmd, ps), cmd).toBe("outside_worktree");
    }
  });

  it("still runs script blocks over the worktree", () => {
    for (const cmd of [
      "Get-ChildItem src | Rename-Item -NewName { $_.Name + '.bak' }",
      "Get-ChildItem src -Filter *.txt | Rename-Item -NewName { $_.Name -replace '.txt','.md' }",
      "Get-ChildItem -Recurse -Filter *.log | Rename-Item -NewName { $_.BaseName + '.old' }",
      "Get-ChildItem src | Set-ItemProperty -Name IsReadOnly -Value { $false }",
      'Get-ChildItem src | Move-Item -Destination { "dist\\$($_.Name)" }',
      "Get-ChildItem src | Copy-Item -Destination { Join-Path dist $_.Name }",
      "Set-Item Function:prompt { 'PS> ' }",
    ]) {
      expect(action(cmd, ps), cmd).toBeNull();
    }
  });
});

describe("Push-Location and Pop-Location (#541)", () => {
  it("restores the earlier location after Pop-Location or popd", () => {
    for (const cmd of [
      "Push-Location HKCU:\\Software; Pop-Location; Remove-Item dist -Recurse",
      "pushd HKCU:\\Software; popd; Remove-Item dist -Recurse",
      "Push-Location C:\\Users\\me; Pop-Location; Remove-Item dist -Recurse",
      "Push-Location C:\\Users\\me; Push-Location D:\\x; Pop-Location; Pop-Location; Remove-Item dist",
      "Push-Location -Path C:\\Users\\me -StackName s; Pop-Location -StackName s; Remove-Item dist",
      "cd packages; pushd C:\\Users\\me; popd; Remove-Item dist -Recurse",
    ]) {
      expect(action(cmd, ps), cmd).toBeNull();
    }
    expect(action("pushd C:\\Users\\me && popd && rd /s /q dist", win)).toBeNull();
    const posix: RiskContext = { cwd: "/work/repo", platform: "linux", home: "/home/me" };
    expect(action("pushd /etc && popd && rm -rf dist", posix)).toBeNull();
  });

  it("still asks while the pushed location is current", () => {
    for (const cmd of [
      "Push-Location C:\\Users\\me; Remove-Item dist -Recurse",
      "Push-Location HKCU:\\Software; Remove-Item Foo -Recurse",
      "pushd C:\\Users\\me; pushd D:\\shared; popd; Remove-Item dist",
      // Only the stack it was pushed on gives it back.
      "Push-Location C:\\Users\\me -StackName s; Pop-Location; Remove-Item dist",
      // A pop with nothing pushed in the command stays where it is.
      "cd C:\\Users\\me; Pop-Location; Remove-Item dist",
      // `popd +1` drops an entry and stays; another default stack is unknown.
      "pushd C:\\Users\\me; popd +1; Remove-Item dist",
      "Push-Location C:\\Users\\me; Set-Location -StackName s; Pop-Location; Remove-Item dist",
      // A new process starts where the shell is, with a stack of its own.
      "Push-Location C:\\Users\\me; pwsh -c 'Pop-Location; Remove-Item dist'",
    ]) {
      expect(action(cmd, ps), cmd).toBe("outside_worktree");
    }
    expect(reason("Push-Location C:\\Users\\me; Remove-Item dist -Recurse", ps)).toBe(
      "Deletes dist, outside the worktree",
    );
  });

  it("saves the location without moving when Push-Location names none", () => {
    expect(action("Push-Location; Remove-Item dist -Recurse", ps)).toBeNull();
    expect(
      action(
        "cd C:\\Users\\me; Push-Location; cd C:\\work\\repo; Pop-Location; Remove-Item dist",
        ps,
      ),
    ).toBe("outside_worktree");
  });
});
