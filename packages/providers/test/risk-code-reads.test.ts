import { describe, expect, it } from "vitest";
import { levelAllows } from "../src/codex/policy";
import { inlineCodePaths } from "../src/policy/inline-code";
import { classifyCommand, type RiskContext } from "../src/policy/risk";

/**
 * Files an interpreter's one-liner or a script written out on its input reads (§11.2): each path
 * literal gets the verdict a direct read of that file gets, so Agent Rishi's own home and credentials
 * ask at every level, an agent CLI's login too, and other credential files ask at Auto.
 */

const posix: RiskContext = {
  cwd: "/home/me/.agent-rishi/wt/repo/abc123",
  platform: "linux",
  home: "/home/me",
  tempRoots: ["/tmp"],
  shell: "posix",
  agentRishiHome: "/home/me/.agent-rishi",
  artifactsDir: "/home/me/.agent-rishi/artifacts/abc123",
};
const win = {
  cwd: "C:\\Users\\me\\.agent-rishi\\wt\\repo\\abc123",
  platform: "win32" as const,
  home: "C:\\Users\\me",
  tempRoots: ["C:\\Users\\me\\AppData\\Local\\Temp"],
  agentRishiHome: "C:\\Users\\me\\.agent-rishi",
};
const ps: RiskContext = { ...win, shell: "powershell" };
const unknownShell: RiskContext = { ...win };

const levels = (command: string, ctx: RiskContext = posix) => {
  const risk = classifyCommand(command, ctx);
  return `${levelAllows("auto", risk) ? "-" : "auto"}/${levelAllows("full", risk) ? "-" : "full"}`;
};
const agentRishi = (command: string, ctx: RiskContext = posix) => {
  const risk = classifyCommand(command, ctx);
  return risk.risky && risk.agentRishi === true;
};

/** One-liners that print the file at `path`, in each interpreter. */
const oneLiners = (path: string) => [
  `python -c "print(open('${path}').read())"`,
  `python3 -c "import pathlib; print(pathlib.Path('${path}').read_text())"`,
  `node -e "console.log(require('fs').readFileSync('${path}', 'utf8'))"`,
  `ruby -e "puts File.read('${path}')"`,
  `perl -e 'open(F, "<${path}"); print <F>'`,
  `php -r "echo file_get_contents('${path}');"`,
];

describe("files an interpreter's code reads", () => {
  it("get the verdict a direct read of the file gets", () => {
    for (const path of [
      "/home/me/.agent-rishi/install-token",
      "~/.agent-rishi/runner/runner.json",
      "/home/me/.agent-rishi/agent-rishi.db",
      "~/.codex/auth.json",
      "~/.ssh/id_rsa",
      "/home/me/.aws/credentials",
      ".env",
    ]) {
      const direct = classifyCommand(`cat ${path}`, posix);
      for (const command of oneLiners(path)) {
        expect(levels(command), command).toBe(levels(`cat ${path}`));
        expect(agentRishi(command), command).toBe(direct.risky && direct.agentRishi === true);
      }
    }
  });

  it("ask at every level for Agent Rishi's own home and credentials", () => {
    for (const command of [
      ...oneLiners("/home/me/.agent-rishi/install-token"),
      ...oneLiners("$HOME/.agent-rishi/remote-access.json"),
      `python -c "import glob; print(glob.glob('/home/me/.agent-rishi/*'))"`,
      // A script written out on the input.
      "python - <<'EOF'\nprint(open('/home/me/.agent-rishi/install-token').read())\nEOF",
      "node <<'EOF'\nconsole.log(require('fs').readFileSync('/home/me/.agent-rishi/install-token', 'utf8'))\nEOF",
      `echo "print(open('/home/me/.agent-rishi/install-token').read())" | python3`,
      `echo '<?php echo file_get_contents("/home/me/.agent-rishi/install-token");' | php`,
      `python3 <<< "print(open('/home/me/.agent-rishi/install-token').read())"`,
      // Through a command the code runs.
      `python -c "import os; os.system('cat /home/me/.agent-rishi/install-token')"`,
    ]) {
      expect(levels(command), command).toBe("auto/full");
      expect(agentRishi(command), command).toBe(true);
    }
  });

  it("ask at every level however the code is given or runs its command", () => {
    const token = "/home/me/.agent-rishi/install-token";
    for (const command of [
      // Code written onto its option.
      `python -c"print(open('${token}').read())"`,
      `perl -e'open(F, "${token}"); print <F>'`,
      `ruby -e"puts File.read('${token}')"`,
      `php -r"echo file_get_contents('${token}');"`,
      // Commands run in backticks, `qx`, `%x`, a pipe `open` and PHP's and Ruby's own calls.
      `perl -le 'print \`cat ${token}\`'`,
      `perl -e 'print qx(cat ${token})'`,
      `perl -e 'open(my $f, "cat ${token} |"); print <$f>'`,
      `ruby -e 'puts %x(cat ${token})'`,
      `ruby -e 'require "open3"; puts Open3.capture2("cat ${token}")[0]'`,
      `php -r 'echo shell_exec("cat ${token}");'`,
      // Code in a string, and a path handed to a print call that keeps it.
      `python3 -c 'exec("print(open(\\"${token}\\").read())")'`,
      `python3 -c "print(p := '${token}') or print(open(p).read())"`,
      `ruby -e "puts(File.read '${token}')"`,
      // An interpreter or a shell a package manager runs by name.
      `pnpm node -e "console.log(require('fs').readFileSync('${token}', 'utf8'))"`,
      `yarn sh -c "cat ${token}"`,
    ]) {
      expect(levels(command), command).toBe("auto/full");
      expect(agentRishi(command), command).toBe(true);
    }
    for (const command of [
      "iex '[IO.File]::ReadAllText(''C:\\Users\\me\\.agent-rishi\\install-token'')'",
      "pwsh -Command '[IO.File]::ReadAllText(''C:\\Users\\me\\.agent-rishi\\install-token'')'",
      "(New-Object System.IO.StreamReader('C:\\Users\\me\\.agent-rishi\\install-token')).ReadToEnd()",
    ]) {
      expect(levels(command, ps), command).toBe("auto/full");
      expect(agentRishi(command, ps), command).toBe(true);
    }
  });

  it("ask for other credential files at Auto, also through a command the code runs", () => {
    for (const command of [
      `python -c "import os; os.system('cat ~/.ssh/id_rsa')"`,
      `node -e "require('child_process').execSync('cat .env')"`,
      "python - <<'EOF'\nprint(open('.env').read())\nEOF",
    ]) {
      expect(levels(command), command).toBe("auto/-");
    }
  });

  it("read the paths PowerShell and Windows interpreters are handed", () => {
    for (const ctx of [ps, unknownShell]) {
      for (const command of [
        "[IO.StreamReader]::new('C:\\Users\\me\\.agent-rishi\\install-token').ReadToEnd()",
        "[System.IO.FileStream]::new('C:\\Users\\me\\.agent-rishi\\install-token', 'Open')",
        "'Get-Content C:\\Users\\me\\.agent-rishi\\install-token' | powershell -Command -",
        "'[IO.File]::ReadAllText(\"C:\\Users\\me\\.agent-rishi\\install-token\")' | pwsh -NoProfile -",
        "'print(open(r\"C:\\Users\\me\\.agent-rishi\\install-token\").read())' | python -",
        `python -c "print(open(r'C:\\Users\\me\\.agent-rishi\\install-token').read())"`,
        `python -c "print(open('$env:USERPROFILE\\.agent-rishi\\install-token').read())"`,
        `node -e "require('fs').readFileSync('C:/Users/me/.agent-rishi/install-token')"`,
      ]) {
        expect(levels(command, ctx), command).toBe("auto/full");
        expect(agentRishi(command, ctx), command).toBe(true);
      }
    }
  });

  it("leave ordinary code, and the session's own artifacts, alone", () => {
    for (const command of [
      `python -c "print(open('README.md').read())"`,
      `node -e "require('fs').readFileSync('package.json')"`,
      `node -e "console.log(require('./package.json').version)"`,
      `python -c "import json; print(json.load(open('tsconfig.json'))['compilerOptions'])"`,
      `ruby -e "puts File.read('Gemfile')"`,
      `python -c "print('/home/me/.agent-rishi')"`,
      `python -c "import sys; print([f for f in sys.argv if f.endswith('.pem')])"`,
      `node -e "fetch('https://example.com/.env').then(r => r.text())"`,
      `python -c "print(open('/home/me/.agent-rishi/artifacts/abc123/shot.png', 'rb').read()[:8])"`,
      "python - <<'EOF'\nprint(open('src/index.ts').read())\nEOF",
      "ruby -e 'puts `git status`'",
      "perl -i.bak -pe 's/foo/bar/' src/index.ts",
      "python -c\"print('hi')\"",
    ]) {
      expect(levels(command), command).toBe("-/-");
    }
    for (const command of [
      "[IO.Path]::Combine('a', 'b')",
      "'Get-ChildItem' | pwsh -Command -",
      "Write-Host 'don''t stop'",
      "New-Object IO.StreamReader('src\\index.ts')",
    ]) {
      expect(levels(command, ps), command).toBe("-/-");
    }
  });
});

describe("inlineCodePaths", () => {
  it("takes every literal that may be a file, its open mode taken off", () => {
    expect(inlineCodePaths(`open(F, "</x/y"); open(G, '>>z')`)).toEqual(["/x/y", "z"]);
    expect(inlineCodePaths(`fs.readFileSync('a.txt', 'utf8')`)).toEqual(["a.txt", "utf8"]);
  });

  it("leaves out URLs and literals only printed or tested", () => {
    expect(inlineCodePaths(`get('https://x/y')`)).toEqual([]);
    expect(inlineCodePaths(`print('/x'); s.endswith('.key')`)).toEqual([]);
    expect(inlineCodePaths(`print(open('/x').read())`)).toEqual(["/x"]);
    expect(inlineCodePaths(`s.endswith(('.pem', '.key'))`)).toEqual([]);
    expect(inlineCodePaths(`print(p := '/x')`)).toEqual(["/x"]);
    expect(inlineCodePaths(`puts("#{File.read('/x')}")`)).toContain("/x");
  });

  it("reads a long call that never closes without backtracking", () => {
    expect(inlineCodePaths(`print(${"'a'  ".repeat(40)}`)).toHaveLength(40);
  });
});
