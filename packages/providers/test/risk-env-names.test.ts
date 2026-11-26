import { describe, expect, it } from "vitest";
import { classifyCommand, type RiskContext } from "../src/policy/risk";

/**
 * Environment variable names versus values (#422). Agents list the names of the variables they
 * have (`Get-ChildItem env: | … Name`, `compgen -e`) and unset variables in their own
 * shell before running tests. Neither prints a value, so neither asks at Auto; anything that
 * prints values keeps the secrets rules (`secrets.ts`), and so does a names-only listing whose
 * names are then used to look the values up.
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
const ps: RiskContext = { ...win, shell: "powershell" };

const action = (command: string, ctx: RiskContext) => {
  const r = classifyCommand(command, ctx);
  return r.risky ? r.action : null;
};

/** Names-only listings in PowerShell, as factory agents write them. */
const POWERSHELL_NAMES = [
  "Get-ChildItem env: | Where-Object { $_.Name -like 'AGENT_RISHI*' } | Select-Object -ExpandProperty Name",
  "Get-ChildItem env: | Where-Object { $_.Name -like 'AGENT_RISHI*' } | ForEach-Object { $_.Name }",
  "Get-ChildItem Env: | Where-Object Name -like 'AGENT_RISHI*' | ForEach-Object Name",
  "gci env: | ? { $_.Name -match '^AGENT_RISHI' } | % { $_.Name }",
  "Get-ChildItem env: | Select-Object Name",
  "Get-ChildItem env: | Select-Object -Property Name | Sort-Object Name",
  "Get-ChildItem env: | Sort-Object Name | Select-Object -ExpandProperty Name | Sort-Object",
  "Get-ChildItem env: | Format-Table Name",
  "(Get-ChildItem env:).Name",
  "(gci env:).Name | Where-Object { $_ -like 'AGENT_RISHI*' }",
  "(Get-ChildItem env:).Name -like 'AGENT_RISHI*'",
  "Get-ChildItem env: -Name",
  "Get-ChildItem -Path Env: -Name | Sort-Object",
  "Get-ChildItem env:AGENT_RISHI* -Name",
  "Get-ChildItem env:AGENT_RISHI* | Select-Object -ExpandProperty Name",
];

/** Names-only listings in POSIX shells: NUL-separated records end where a variable does (#448). */
const POSIX_NAMES = [
  "printenv -0 | cut -z -d= -f1 | tr '\\0' '\\n'",
  "printenv --null | cut -z -d '=' -f 1 | tr '\\0' '\\n' | grep AGENT_RISHI",
  "env -0 | cut -zd= -f1 | tr '\\0' '\\n' | sort",
  "env -0 | sed -z 's/=.*//' | tr '\\0' '\\n'",
  "printenv -0 | sed -z -e 's/=.*$//' | tr '\\0' '\\n'",
  "compgen -e",
  "compgen -e | grep AGENT_RISHI",
  "bash -c \"printenv -0 | cut -z -d= -f1 | tr '\\0' '\\n'\"",
  'pwsh -NoProfile -Command "(Get-ChildItem env:).Name"',
];

/** Names-only listings from cmd: PowerShell run from it. */
const CMD_NAMES = [
  'powershell -NoProfile -Command "Get-ChildItem env: | Select-Object -ExpandProperty Name"',
  'powershell -NoProfile -Command "(Get-ChildItem env:).Name"',
  'cmd /c "powershell -NoProfile -Command Get-ChildItem env: -Name"',
];

/** Unsetting variables in the agent's own shell: it only affects that process. */
const UNSETS: Array<[string, RiskContext]> = [
  [
    "Remove-Item Env:AGENT_RISHI_HOME, Env:AGENT_RISHI_DEPS_INSTALLER -ErrorAction SilentlyContinue",
    ps,
  ],
  ["Remove-Item Env:AGENT_RISHI_*", ps],
  ["Remove-Item -Path Env:\\AGENT_RISHI_HOME", ps],
  ["Remove-Item Env:AGENT_RISHI_HOME; pnpm test", ps],
  ["$env:AGENT_RISHI_HOME = $null", ps],
  [
    "Get-ChildItem env: | Where-Object { $_.Name -like 'AGENT_RISHI*' } | ForEach-Object { Remove-Item \"Env:$($_.Name)\" }",
    ps,
  ],
  ["Get-ChildItem env: | Where-Object Name -like 'AGENT_RISHI*' | Remove-Item", ps],
  ["Get-ChildItem Env:AGENT_RISHI* | Remove-Item", ps],
  ["unset AGENT_RISHI_HOME AGENT_RISHI_DEPS_INSTALLER", posix],
  ["unset AGENT_RISHI_HOME && pnpm test", posix],
  ["env -u AGENT_RISHI_HOME -u AGENT_RISHI_DEPS_INSTALLER pnpm test", posix],
  ["set AGENT_RISHI_HOME=", win],
];

describe("environment variable names (#422)", () => {
  it("lets names-only listings run at Auto", () => {
    for (const cmd of POWERSHELL_NAMES) {
      expect(action(cmd, ps), cmd).toBeNull();
      expect(action(cmd, win), `${cmd} (shell unknown)`).toBeNull();
    }
    for (const cmd of POSIX_NAMES) expect(action(cmd, posix), cmd).toBeNull();
    for (const cmd of CMD_NAMES) expect(action(cmd, win), cmd).toBeNull();
  });

  it("lets agents unset variables in their own shell", () => {
    for (const [cmd, ctx] of UNSETS) expect(action(cmd, ctx), cmd).toBeNull();
  });

  it("keeps asking for listings that print values", () => {
    for (const cmd of [
      "printenv",
      "printenv GITHUB_TOKEN",
      "printenv PATH OPENAI_API_KEY",
      "printenv | grep AGENT_RISHI",
      "printenv | sort",
      "printenv | cut -d= -f2",
      "printenv | cut -d= -f1,2",
      "printenv | sed 's/^/x/'",
      "printenv | awk -F= '{print $2}'",
    ]) {
      expect(action(cmd, posix), cmd).toBe("secrets");
    }
    for (const cmd of [
      "Get-ChildItem env:",
      "ls env:*",
      "Get-ChildItem Env:AWS_SECRET_ACCESS_KEY",
      "Get-ChildItem env: | Where-Object { $_.Name -like 'AGENT_RISHI*' }",
      "Get-ChildItem env: | Sort-Object Name",
      "Get-ChildItem env: | Select-Object Name, Value",
      "Get-ChildItem env: | Select-Object -ExpandProperty Value",
      "Get-ChildItem env: | Format-Table -AutoSize",
      "Get-ChildItem env: | Out-String",
      "(Get-ChildItem env:).Value",
      "(Get-ChildItem env:)",
      "Get-ChildItem env: | ForEach-Object { $_.Name + '=' + $_.Value }",
      'Get-ChildItem env: | ForEach-Object { "$($_.Name)=$($_.Value)" }',
      "Get-ChildItem env: | Where-Object { $_.Value -like '*ghp_*' } | Select-Object -ExpandProperty Name",
    ]) {
      expect(action(cmd, ps), cmd).toBe("secrets");
    }
  });

  it("leaves single variables as they were", () => {
    // Printing one variable that doesn't look like a credential was, and stays, allowed.
    for (const [cmd, ctx] of [
      ["printenv PATH", posix],
      ["Get-ChildItem env:PATH", ps],
      ["$env:PATH -split ';'", ps],
    ] as const) {
      expect(action(cmd, ctx), cmd).toBeNull();
    }
  });

  it("asks when the names are used to look the values up", () => {
    for (const cmd of [
      "Get-ChildItem env: | Where-Object { $_.Name -like 'AGENT_RISHI*' } | ForEach-Object { $_.Value }",
      "Get-ChildItem env: | Select-Object -ExpandProperty Name | ForEach-Object { $_.Value }",
      "Get-ChildItem env: | Select-Object Name | ForEach-Object { $_.Value }",
      'Get-ChildItem env: -Name | ForEach-Object { Get-Item "env:$_" }',
      "(Get-ChildItem env:).Name | ForEach-Object { [Environment]::GetEnvironmentVariable($_) }",
      'Get-ChildItem env: -Name | Select-Object -First 5 | ForEach-Object { (Get-Item "env:$_").Value }',
    ]) {
      expect(action(cmd, ps), cmd).toBe("secrets");
    }
    for (const cmd of [
      "printenv | cut -d= -f1 | xargs printenv",
      "printenv | cut -d= -f1 | xargs -I{} sh -c 'echo {}=$(printenv {})'",
    ]) {
      expect(action(cmd, posix), cmd).toBe("secrets");
    }
  });
});

/**
 * Names-only listings that could still be steered to print values (#448): an `-OutVariable` that
 * keeps the entries for a later `$v`, a script block in `Where-Object` or `Sort-Object` that
 * writes each entry to the host (PowerShell prints `[NAME, value]`), and line-based tools that cut
 * `NAME=value` at `=`, which pass on the other lines of a value that spans several (a private key).
 */
describe("names-only listings steered to print values (#448)", () => {
  it("asks when an output variable keeps the entries", () => {
    for (const cmd of [
      "Get-ChildItem env: -OutVariable v | Select-Object -ExpandProperty Name; $v",
      "Get-ChildItem env: -ov v | Select-Object -ExpandProperty Name; $v | Format-List",
      "Get-ChildItem env: -OutVariable:v | ForEach-Object { $_.Name }; $v",
      "(Get-ChildItem env: -OutVariable v).Name; $v",
      "Get-ChildItem env: | Where-Object Name -like 'AGENT_RISHI*' -OutVariable v | Select-Object -ExpandProperty Name; $v",
      "Get-ChildItem env: | Sort-Object Name -OutVar v | ForEach-Object Name; $v",
    ]) {
      expect(action(cmd, ps), cmd).toBe("secrets");
    }
  });

  it("asks when a Where-Object or Sort-Object script block may print the entries", () => {
    for (const cmd of [
      "(Get-ChildItem env: | Where-Object { Write-Host $_ }).Name",
      "(gci env: | ? { Write-Warning $_ }).Name",
      "(Get-ChildItem env: | Where-Object { Out-Host -InputObject $_ }).Name",
      "Get-ChildItem env: | Where-Object { Write-Host $_ } | Select-Object -ExpandProperty Name",
      "Get-ChildItem env: | Where-Object -FilterScript { Write-Host $_ } | ForEach-Object Name",
      "Get-ChildItem env: | Sort-Object { Write-Host $_ } | Select-Object -ExpandProperty Name",
      "Get-ChildItem env: | Where-Object { $x = Write-Host $_ } | Select-Object -ExpandProperty Name",
    ]) {
      expect(action(cmd, ps), cmd).toBe("secrets");
    }
  });

  it("asks when names are cut from lines, which a value spanning lines passes", () => {
    for (const cmd of [
      "printenv | cut -d= -f1",
      "env | cut -d= -f1 | sort",
      "printenv | sed 's/=.*//'",
      "printenv | awk -F= '{print $1}'",
      "printenv | grep -i agent-rishi | cut -d= -f1",
      'bash -c "printenv | cut -d= -f1"',
      // NUL-separated records, cut at newlines all the same.
      "printenv -0",
      "printenv -0 | cut -d= -f1",
      "env -0 | sed 's/=.*//'",
      "printenv -0 | tr '\\0' '\\n' | cut -d= -f1",
      "printenv -0 | grep -z AGENT_RISHI | cut -z -d= -f1",
    ]) {
      expect(action(cmd, posix), cmd).toBe("secrets");
    }
    const loop = "for /f \"delims==\" %i in ('set') do @echo %i";
    expect(action(loop, win), loop).toBe("secrets");
  });

  it("still lets script blocks that only compare, and names kept in a variable, run", () => {
    for (const cmd of [
      "(Get-ChildItem env: | Where-Object { $_.Name -like $pattern }).Name",
      "Get-ChildItem env: | Where-Object { $_.Name -match '^AGENT_RISHI' -and $_.Name -ne 'AGENT_RISHI_HOME' } | Select-Object -ExpandProperty Name",
      "Get-ChildItem env: | Where-Object -FilterScript { -not $_.Name -like 'PS*' } | ForEach-Object Name",
      "Get-ChildItem env: | Where-Object { $wanted -contains $_.Name } | Select-Object -ExpandProperty Name",
      "Get-ChildItem env: | Sort-Object { $_.Name } | Select-Object -ExpandProperty Name",
      "Get-ChildItem env: -Name -OutVariable names; $names",
    ]) {
      expect(action(cmd, ps), cmd).toBeNull();
    }
  });
});
