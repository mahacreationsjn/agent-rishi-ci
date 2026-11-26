import { describe, expect, it } from "vitest";
import { classifyCommand, classifyRead, type RiskContext } from "../src/policy/risk";

/**
 * Other ways to dump the environment (#447). `printenv` and `Get-ChildItem env:` ask at Auto
 * (`env-dumps.ts`); bare `env`, `export -p`, `set`, .NET's `GetEnvironmentVariables()`, inline
 * code printing `process.env` or `os.environ` whole and `/proc/<pid>/environ` print the same
 * values, so they ask too. Running a command through `env`, setting variables, shell options,
 * single variables and names-only listings keep running freely.
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

describe("environment dumps beyond printenv (#447)", () => {
  it("asks for bare env and the shells' export listings", () => {
    for (const cmd of [
      "env",
      "env | sort",
      "env | grep AGENT_RISHI",
      "env -0",
      "env -u GITHUB_TOKEN",
      "env FOO=1",
      "command env",
      "/usr/bin/env",
      'bash -c "env"',
      "export -p",
      "export",
      "declare -x",
      "declare -p",
      "declare -p GITHUB_TOKEN",
      "typeset -x",
      "set",
      "set | grep TOKEN",
      // A value spanning lines passes its other lines through `cut` (#448).
      "env | cut -d= -f1",
      "export -p | cut -d= -f1",
    ]) {
      expect(action(cmd, posix), cmd).toBe("secrets");
    }
  });

  it("asks for cmd's set", () => {
    for (const cmd of [
      "set",
      "set | findstr AGENT_RISHI",
      "set C",
      'cmd /c "set"',
      "for /f \"tokens=1,2 delims==\" %i in ('set') do @echo %i=%j",
      "for /f \"delims==\" %i in ('set') do @echo %i & set %i",
      // A value spanning lines passes its other lines through the loop (#448).
      "for /f \"delims==\" %i in ('set') do @echo %i",
      "for /f \"tokens=1 delims==\" %%i in ('set') do @echo %%i",
    ]) {
      expect(action(cmd, win), cmd).toBe("secrets");
    }
  });

  it("asks for .NET's environment listing", () => {
    for (const cmd of [
      "[Environment]::GetEnvironmentVariables()",
      "[System.Environment]::GetEnvironmentVariables('Process')",
      "[Environment]::GetEnvironmentVariables() | Format-Table",
      "$vars = [Environment]::GetEnvironmentVariables(); $vars",
      'pwsh -NoProfile -Command "[Environment]::GetEnvironmentVariables()"',
    ]) {
      expect(action(cmd, ps), cmd).toBe("secrets");
    }
  });

  it("asks when inline code prints the whole environment", () => {
    for (const cmd of [
      'node -e "console.log(process.env)"',
      "node -p process.env",
      'node -e "console.log(JSON.stringify(process.env, null, 2))"',
      'node -e "for (const k in process.env) console.log(k, process.env[k])"',
      "node -e \"Object.keys(process.env).forEach((k) => console.log(k + '=' + process.env[k]))\"",
      'bun -e "console.log(Bun.env)"',
      'deno eval "console.log(Deno.env.toObject())"',
      'python -c "import os; print(os.environ)"',
      'python3 -c "import os; print(dict(os.environ))"',
      'python3 -c "import os; print(os.environ.items())"',
      'python3 -c "import os\nfor k, v in os.environ.items(): print(k, v)"',
      'python3 -c "import os; [print(k, v) for k, v in os.environ.items()]"',
      "python3 -c \"import os; print('\\n'.join(f'{k}={v}' for k, v in os.environ.items()))\"",
      'python3 -c "import os; [print(v) for v in os.environ.values()]"',
      'python3 -c "import os\nfor k in os.environ.copy(): print(k)"',
      'python3 -c "import os\nfor k in os.environ: print(k, os.environ[k])"',
      'python3 -c "import os\nfor k in os.environ.keys(): print(os.environ.get(k))"',
      'python3 -c "import os\nfor k in os.environ: print(k, os.getenv(k))"',
    ]) {
      expect(action(cmd, posix), cmd).toBe("secrets");
    }
  });

  it("asks for /proc/<pid>/environ", () => {
    for (const cmd of [
      "cat /proc/self/environ",
      "tr '\\0' '\\n' < /proc/self/environ",
      "strings /proc/1/environ",
      "xargs -0 -L1 -a /proc/self/environ",
    ]) {
      expect(action(cmd, posix), cmd).toBe("secrets");
    }
    expect(classifyRead("/proc/self/environ", posix)).toMatchObject({ action: "secrets" });
  });

  it("keeps commands that print no environment values running freely", () => {
    for (const cmd of [
      "env -u AGENT_RISHI_HOME pnpm test",
      "env FOO=1 pnpm test",
      "/usr/bin/env python3 scripts/check.py",
      "env -i PATH=/usr/bin node build.js",
      "env -i",
      'env -S "pnpm test"',
      "env -0 | cut -z -d= -f1 | tr '\\0' '\\n'",
      "export FOO=1",
      'export PATH="$PATH:/opt/bin"',
      "declare -p PATH",
      "declare -f",
      "set -euo pipefail",
      "set -- a b",
      "set +x",
      'node -e "console.log(process.env.NODE_ENV)"',
      "node -e \"console.log(process.env['CI'])\"",
      "node -p \"Object.keys(process.env).filter((k) => k.startsWith('AGENT_RISHI'))\"",
      "node -e \"console.log('CI' in process.env)\"",
      "python -c \"import os; print(os.environ.get('HOME'))\"",
      'python -c "import os; print(sorted(os.environ.keys()))"',
      "python -c \"import os; print('CI' in os.environ)\"",
      'python3 -c "import os\nfor k in os.environ: print(k)"',
      "python3 -c \"import os; print(os.environ['HOME'], os.getenv('PATH', ''))\"",
      'grep -rn "process.env" src',
      "rg 'os.environ' .",
      "ls /proc/self/",
      "cat /proc/self/status",
    ]) {
      expect(action(cmd, posix), cmd).toBeNull();
    }
    for (const cmd of ["set AGENT_RISHI_HOME=", 'set "PATH=%PATH%;C:\\tools"', "set /a n=1+2"]) {
      expect(action(cmd, win), cmd).toBeNull();
    }
    for (const cmd of [
      "[Environment]::GetEnvironmentVariable('PATH')",
      "$env:PATH -split ';'",
      "Write-Output '[Environment]::GetEnvironmentVariables()'",
    ]) {
      expect(action(cmd, ps), cmd).toBeNull();
    }
  });
});
