import { describe, expect, it } from "vitest";
import { levelAllows } from "../src/codex/policy";
import { classifyCommand, type RiskContext } from "../src/policy/risk";
import { parseShell } from "../src/policy/shell";

/**
 * Commands inside script blocks and function bodies are classified like the commands around them,
 * and words are unescaped the way the shell that runs them does, before any path is resolved.
 */

const posix: RiskContext = {
  cwd: "/work/repo",
  platform: "linux",
  home: "/home/me",
  tempRoots: ["/tmp"],
  shell: "posix",
  agentRishiHome: "/home/me/.agent-rishi",
};
const win: RiskContext = {
  cwd: "C:\\work\\repo",
  platform: "win32",
  home: "C:\\Users\\me",
  tempRoots: ["C:\\Users\\me\\AppData\\Local\\Temp"],
  agentRishiHome: "C:\\Users\\me\\.agent-rishi",
};
const ps: RiskContext = { ...win, shell: "powershell" };
const gitBash: RiskContext = { ...win, shell: "posix" };
/** A shell that isn't known, on Linux (Codex, OpenCode and ACP agents name none). */
const unknown: RiskContext = { ...posix, shell: "auto" };

const levels = (command: string, ctx: RiskContext) => {
  const risk = classifyCommand(command, ctx);
  return `${levelAllows("auto", risk) ? "-" : "auto"}/${levelAllows("full", risk) ? "-" : "full"}`;
};
const asksAtBoth = (commands: string[], ctx: RiskContext) => {
  for (const command of commands) expect(levels(command, ctx), command).toBe("auto/full");
};
const neverAsks = (commands: string[], ctx: RiskContext) => {
  for (const command of commands) expect(levels(command, ctx), command).toBe("-/-");
};

describe("PowerShell script blocks", () => {
  it("classifies the commands inside a block", () => {
    asksAtBoth(
      [
        "if ($true) { Remove-Item -Recurse -Force C:\\other }",
        "if ($true){Remove-Item -Recurse -Force C:\\other}",
        "if ($true) {\n  Remove-Item -Recurse -Force C:\\other\n}",
        "if ($x) { git status } else { Set-Content C:\\other\\x hi }",
        "try { Remove-Item -Recurse -Force C:\\other } catch { Write-Host no }",
        "try { git status } catch { Remove-Item -Recurse -Force C:\\other }",
        "try{Remove-Item C:\\other\\x}catch{}",
        "foreach ($i in 1..2) { Remove-Item -Recurse -Force C:\\other }",
        "while ($true) { Remove-Item C:\\other\\x; break }",
        "switch (1) { 1 { Remove-Item -Recurse C:\\other } }",
        "& { Remove-Item -Recurse -Force C:\\other }",
        ". { Remove-Item -Recurse -Force C:\\other }",
        "Invoke-Command -ScriptBlock { Remove-Item -Recurse -Force C:\\other }",
        "if ($a) { if ($b) { 'x' > C:\\other\\x.txt } }",
        "if ($true) { cd C:\\other; git clean -fdx }",
        "if ($true) { cd C:\\other }; git clean -fdx",
        'powershell -Command "if ($true) { Remove-Item -Recurse C:\\other }"',
      ],
      ps,
    );
    asksAtBoth(["if ($true) { Remove-Item -Recurse -Force C:\\other }"], win);
    asksAtBoth(['powershell -c "if (1) { Remove-Item -Recurse C:\\other }"'], gitBash);
  });

  it("asks at every level for Agent Rishi's home inside a block", () => {
    const risk = classifyCommand(
      "if ($x) { Get-Content C:\\Users\\me\\.agent-rishi\\install.json }",
      ps,
    );
    expect(risk).toMatchObject({ risky: true, agentRishi: true });
  });

  it("classifies a function's body where it is called", () => {
    asksAtBoth(
      [
        "function f { Remove-Item -Recurse -Force C:\\other }; f",
        "function f { git clean -fdx }; cd C:\\other; f",
        "function f { cd C:\\other }; cd C:\\work\\repo; f; git clean -fdx",
        "function Clean-Up($dir) { git clean -fdx }; Set-Location ..; Clean-Up x",
      ],
      ps,
    );
  });

  it("asks for a block that never closes, unless the command only reads", () => {
    expect(levels("if ($x) { Write-Host hi", ps)).toBe("auto/-");
    expect(levels("if ($x) { Remove-Item C:\\other\\x", ps)).toBe("auto/full");
    expect(levels("Get-ChildItem | Where-Object { $_.Length -gt 10", ps)).toBe("-/-");
  });

  it("leaves ordinary blocks alone", () => {
    neverAsks(
      [
        "if (Test-Path dist) { Remove-Item -Recurse dist }",
        "if ($true) { Remove-Item -Recurse -Force .\\dist }; pnpm build",
        "try { pnpm test } catch { Write-Host failed }",
        "foreach ($f in Get-ChildItem src) { Copy-Item $f.FullName $env:TEMP }",
        "Get-ChildItem | Where-Object { $_.Length -gt 10 } | ForEach-Object { $_.Name }",
        "Get-ChildItem | Rename-Item -NewName { $_.Name + '.bak' }",
        "$h = @{ Path = 'src'; Force = $true }; $h.Path",
        "git stash drop stash@{0}",
        "function Build { Set-Location packages\\x; pnpm build }; Build",
        "if ($x) { 'a' > $env:TEMP\\a.txt }",
      ],
      ps,
    );
  });

  it("keeps a block's words for the rules that read it as an argument", () => {
    const [cmd] = parseShell("Rename-Item a -NewName { $_.Name + '.bak' }", "powershell");
    expect(cmd?.words).toEqual(["Rename-Item", "a", "-NewName", "{", "$_.Name", "+", ".bak", "}"]);
    expect(cmd?.blocks?.[0]?.[0]?.words).toEqual(["$_.Name", "+", ".bak"]);
    expect(parseShell("echo $HOME {a,b}", "posix")[0]?.blocks).toBeUndefined();
  });
});

describe("shell functions", () => {
  it("classifies the body, and again where the function is called", () => {
    asksAtBoth(
      [
        "f() { rm -rf /other; }; f",
        "f(){ rm -rf /other;};f",
        "f() {\n  rm -rf /other\n}\nf",
        "function f { rm -rf /other; }; f",
        "function f() { echo hi > /etc/profile; }; f",
        "f() ( rm -rf /other ); f",
        "f() { cd /other && git clean -fdx; }; f",
        "f() { git clean -fdx; }; cd /other; f",
        "f() { git clean -fdx; }; (cd /other && f)",
        "f() { git clean -fdx; }; g() { cd /other; f; }; g",
        "case $x in a) rm -rf /other;; *) echo no;; esac",
      ],
      posix,
    );
    asksAtBoth(["f() { rm -rf /other; }; f", "f() { git clean -fdx; }; cd /other; f"], unknown);
    asksAtBoth(["f() { rm -rf /c/other; }; f"], gitBash);
  });

  it("reads a header written apart from its name or its body", () => {
    const apart = [
      "f () { rm -rf /other; }; f",
      "f () { git clean -fdx; }; cd /other && f",
      "f () { cd /other; }; f; git clean -fdx",
      "f ()\n{\n  cd /other\n}\nf\ngit clean -fdx",
      "f()\n{\n  git clean -fdx\n}\ncd /other\nf",
    ];
    asksAtBoth(apart, posix);
    asksAtBoth(apart, unknown);
    neverAsks(["build () { pnpm build; }; build", "clean ()\n{\n  rm -rf dist\n}\nclean"], posix);
  });

  it("ends for a function that calls itself", () => {
    expect(levels("f() { f; }; f", posix)).toBe("-/-");
    expect(levels("f() { g; }; g() { f; rm -rf /other; }; f", posix)).toBe("auto/full");
  });

  it("leaves functions that stay in the worktree alone", () => {
    neverAsks(
      [
        "f() { echo hi; }; f",
        "build() { cd packages/x && pnpm build; }; build",
        "clean() { rm -rf ./dist /tmp/build-cache; }; clean",
        'retry() { for i in 1 2 3; do "$@" && return; done; }; retry pnpm test',
        "if [ -f a ]; then echo yes; fi",
        'for f in *.ts; do echo "$f"; done',
        "case $x in a) echo one;; *) echo other;; esac",
      ],
      posix,
    );
  });
});

describe("escapes are read the way the shell reads them", () => {
  it("removes a POSIX shell's backslash escapes before resolving paths", () => {
    asksAtBoth(
      [
        "rm -rf /work/repo/\\.\\./\\.\\./other",
        "rm -rf ../\\../other",
        "cd \\.\\. && git clean -fdx",
        "cd sub/\\.\\./\\.\\. && git clean -fdx",
        "rm -rf \\/other",
        "rm -rf \\~/projects",
        "r\\m -rf /other",
        "echo hi > \\/etc/profile",
        "rm -rf /work/repo/$'\\x2e\\x2e'/$'\\056\\056'/other",
        "bash -c 'rm -rf /work/repo/\\.\\./\\.\\./other'",
      ],
      posix,
    );
    asksAtBoth(["rm -rf /work/repo/\\.\\./\\.\\./other", "cd \\.\\. && git clean -fdx"], unknown);
    expect(classifyCommand("rm -rf /work/repo/\\.\\./\\.\\./other", posix)).toMatchObject({
      reason: "Deletes /work/repo/../../other, outside the worktree",
    });
    expect(classifyCommand("cat \\.env", posix)).toMatchObject({ action: "secrets" });
    expect(classifyCommand("cat /home/me/\\.agent-rishi/install.json", posix)).toMatchObject({
      agentRishi: true,
    });
  });

  it("reads them in Git Bash and in an unknown shell on Windows", () => {
    asksAtBoth(
      [
        "rm -rf /c/work/repo/\\.\\./\\.\\./other",
        "cd \\.\\. && git clean -fdx",
        "r\\m -rf /c/other",
        "rm -rf \\/c/other",
      ],
      gitBash,
    );
    asksAtBoth(["rm -rf /c/work/repo/\\.\\./\\.\\./other", "cd \\.\\. && git clean -fdx"], win);
  });

  it("keeps Windows paths with backslash separators", () => {
    neverAsks(
      [
        "rd /s /q C:\\work\\repo\\dist",
        "del C:\\work\\repo\\.git\\index.lock",
        "type C:\\work\\repo\\sub\\..\\x.txt > C:\\work\\repo\\.cache\\out.txt",
        "echo hi > C:\\Users\\me\\AppData\\Local\\Temp\\a.txt",
        "copy src\\a.ts src\\..\\b.ts",
        "git diff HEAD^ HEAD",
        'findstr /r "^foo" a.txt',
      ],
      win,
    );
    neverAsks(
      [
        "Remove-Item -Recurse C:\\work\\repo\\dist",
        "Copy-Item .\\src\\a.ts ..\\repo\\b.ts",
        "Get-Content .\\.gitignore",
      ],
      ps,
    );
    neverAsks(
      [
        "rm -rf 'C:\\work\\repo\\dist'",
        'rm -rf "C:\\work\\repo\\dist"',
        "rm -rf /c/work/repo/dist",
        "cat src\\lib\\a.ts",
      ],
      gitBash,
    );
    asksAtBoth(["rd /s /q C:\\work\\repo\\..\\other", "del ..\\other\\x.txt"], win);
  });

  it("reads PowerShell's backtick and cmd's caret", () => {
    asksAtBoth(
      [
        "Remove-Item -Recurse C:\\work\\repo\\`.`.\\`.`.\\other",
        "cd `.`. ; git clean -fdx",
        "Re`move-Item -Recurse C:\\other",
      ],
      ps,
    );
    asksAtBoth(
      [
        "rd /s /q C:\\work\\repo\\^.^.\\^.^.\\other",
        "cd ^.^. && git clean -fdx",
        "r^d /s /q C:\\other",
        'cmd /c "r^d /s /q C:\\other"',
      ],
      win,
    );
  });

  it("leaves ordinary escapes alone", () => {
    neverAsks(
      [
        'grep -rn "a\\|b" src | head',
        "grep -n 'foo\\.bar' src/a.ts",
        "sed -i 's/a\\/b/c/' src/a.ts",
        "find . -name \\*.ts -not -path ./node_modules/\\*",
        'echo "a\\nb" > /tmp/out.txt',
        "ls my\\ folder",
        "rm -rf /work/repo/a\\ b",
        "git commit -m fix\\ it",
        "printf '%s\\n' a b",
      ],
      posix,
    );
    expect(parseShell("rm a\\ b \\$x c\\;d", "posix", "posix")[0]?.words).toEqual([
      "rm",
      "a b",
      "$x",
      "c;d",
    ]);
    expect(parseShell("rd C:\\a\\.git ..\\x \\.\\./y", "auto", "careful")[0]?.words).toEqual([
      "rd",
      "C:\\a\\.git",
      "..\\x",
      "../y",
    ]);
  });
});
