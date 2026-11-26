import { describe, expect, it } from "vitest";
import { levelAllows } from "../src/codex/policy";
import { classifyCommand, type RiskContext } from "../src/policy/risk";
import { gitWrites, toolWrites } from "../src/policy/write-tools";

/**
 * Commands and writes that go through something else: PowerShell without a cmdlet, the commands
 * git, awk, trap, alias, find and package runners run, more wrappers and more tools that write.
 */

const posix: RiskContext = {
  cwd: "/work/repo",
  platform: "linux",
  home: "/home/me",
  tempRoots: ["/tmp"],
  shell: "posix",
  agentRishiHome: "/home/me/.agent-rishi",
};
const win = {
  cwd: "C:\\work\\repo",
  platform: "win32" as const,
  home: "C:\\Users\\me",
  tempRoots: ["C:\\Users\\me\\AppData\\Local\\Temp"],
};
const ps: RiskContext = { ...win, shell: "powershell" };
const gitBash: RiskContext = { ...win, shell: "posix" };

/** `Remove-Item C:\other -Recurse`, as `-EncodedCommand` takes it. */
const ENCODED = Buffer.from("Remove-Item C:\\other -Recurse", "utf16le").toString("base64");

const levels = (command: string, ctx: RiskContext = posix) => {
  const risk = classifyCommand(command, ctx);
  return `${levelAllows("auto", risk) ? "-" : "auto"}/${levelAllows("full", risk) ? "-" : "full"}`;
};
const asksAtBoth = (commands: string[], ctx: RiskContext = posix) => {
  for (const command of commands) expect(levels(command, ctx), command).toBe("auto/full");
};
const asksAtAuto = (commands: string[], ctx: RiskContext = posix) => {
  for (const command of commands) expect(levels(command, ctx), command).toBe("auto/-");
};
const neverAsks = (commands: string[], ctx: RiskContext = posix) => {
  for (const command of commands) expect(levels(command, ctx), command).toBe("-/-");
};

describe("PowerShell without a cmdlet", () => {
  it("judges the paths .NET file calls write or delete", () => {
    asksAtBoth(
      [
        "[IO.Directory]::Delete('C:\\other', $true)",
        '[System.IO.Directory]::Delete("C:\\other", $true)',
        "[IO.File]::Delete('C:\\other\\x.txt')",
        "[System.IO.File]::WriteAllText('C:\\other\\x.txt', 'hi')",
        "[IO.File]::Move('a.txt','C:\\other\\a.txt')",
        "[IO.File]::Copy('a','C:\\other\\a')",
        "$p='C:\\other'; [IO.Directory]::Delete($p,$true)",
        "[IO.File]::Delete($args[0])",
        "Get-ChildItem C:\\other | % { [IO.File]::Delete($_.FullName) }",
      ],
      ps,
    );
  });

  it("classifies a script block made from a string", () => {
    asksAtBoth(
      [
        "[scriptblock]::Create('Remove-Item C:\\other -Recurse').Invoke()",
        "& ([scriptblock]::Create('Remove-Item C:\\other -Recurse'))",
        'Invoke-Command -ScriptBlock ([scriptblock]::Create("Remove-Item C:\\other"))',
      ],
      ps,
    );
    asksAtAuto(["[scriptblock]::Create($s).Invoke()"], ps);
  });

  it("decodes an encoded command", () => {
    asksAtBoth(
      [
        `powershell -EncodedCommand ${ENCODED}`,
        `pwsh -enc ${ENCODED}`,
        `powershell -NoProfile -e ${ENCODED}`,
      ],
      ps,
    );
    asksAtBoth([`powershell -enc ${ENCODED}`], gitBash);
    asksAtAuto(["powershell -enc !!!", "pwsh -EncodedCommand $x"], ps);
  });

  it("takes a piped delete's target from the head of the pipe", () => {
    asksAtBoth(
      [
        "Get-ChildItem C:\\other | % { Remove-Item $_.FullName }",
        "gci C:\\other | foreach { rm $_ }",
        "Get-ChildItem C:\\other -Recurse | Where-Object { $_.Length -gt 0 } | % { Remove-Item $_.FullName }",
      ],
      ps,
    );
  });

  it("leaves reads and other types alone", () => {
    neverAsks(
      [
        "[IO.Path]::Combine('a','b')",
        "[IO.File]::ReadAllText('C:\\other\\x')",
        "[IO.File]::Exists('C:\\other\\x')",
        "[IO.File]::WriteAllText(\"$env:TEMP\\x.txt\", 'hi')",
        "[IO.File]::WriteAllText('notes.txt', 'hi')",
        "$f = Join-Path $env:TEMP 'msg.txt'; [IO.File]::WriteAllText($f, 'hi'); git commit -F $f",
      ],
      ps,
    );
  });
});

describe("commands run through other tools", () => {
  it("classifies what git runs", () => {
    asksAtBoth([
      "git rebase -x 'rm -rf /other' main",
      "git rebase --exec='rm -rf /other' main",
      'git rebase -i --exec "rm -rf /other" HEAD~2',
      "git bisect run rm -rf /other",
      "git -C . bisect run sh -c 'rm -rf /other'",
      "git submodule foreach 'rm -rf /other'",
      "git submodule foreach --recursive 'rm -rf /other'",
      "git -c alias.x='!rm -rf /other' x",
      "git -c alias.x='!f() { rm -rf /other; }; f' x",
      "git -c core.pager='rm -rf /other' log",
    ]);
  });

  it("classifies what awk, trap and an alias run", () => {
    asksAtBoth([
      `awk 'BEGIN{system("rm -rf /other")}'`,
      `gawk 'BEGIN { system("rm -rf /other") }'`,
      `awk 'BEGIN{ "rm -rf /other" | getline }'`,
      "trap 'rm -rf /other' EXIT",
      'trap "rm -rf /other" EXIT INT',
      "alias x='rm -rf /other'; x",
    ]);
    asksAtAuto([`awk '{ system("rm -rf " $1) }' list`]);
  });

  it("classifies what find, fd and xargs run", () => {
    asksAtBoth([
      "find . -exec sh -c 'rm -rf /other' \\;",
      "find . -execdir sh -c 'rm -rf /other' \\;",
      "find . -exec cp {} /other/ \\;",
      "find /other -exec chmod 777 {} +",
      "fd . -x cp {} /other/",
      "ls | xargs -I{} cp {} /other/",
      "ls /other | xargs chmod 777",
      "echo /other | xargs rm -rf",
    ]);
  });

  it("leaves ordinary uses alone", () => {
    neverAsks([
      "git rebase main",
      "git rebase -i HEAD~3",
      "git submodule update --init",
      "git bisect start",
      "awk '{print $1}' file",
      `awk -F, '{print $2 "|" $3}' f`,
      "alias ll='ls -l'",
      "trap - EXIT",
      "find . -name '*.ts' -exec grep -l foo {} +",
      "find . -type f -exec sed -i 's/a/b/' {} +",
      "git ls-files | xargs prettier --write",
    ]);
  });
});

describe("more wrappers", () => {
  it("classifies the command they run", () => {
    asksAtBoth([
      "flock /tmp/l rm -rf /other",
      "flock -n /tmp/l -c 'rm -rf /other'",
      "chroot /mnt rm -rf /x",
      "strace -f -o /tmp/t rm -rf /other",
      "watch 'rm -rf /other'",
      "watch -n 1 rm -rf /other",
      "su -c 'rm -rf /other'",
      "su root -c 'rm -rf /other'",
      "taskset -c 0 rm -rf /other",
      "taskset 0x1 rm -rf /other",
      "unbuffer rm -rf /other",
    ]);
  });

  it("classifies the tool a package runner starts", () => {
    asksAtBoth([
      "npx rimraf /other",
      "npx --yes rimraf /other",
      "npx -p rimraf rimraf /other",
      "npx -c 'rm -rf /other'",
      "npx shx rm -rf /other",
      "pnpm exec rimraf /other",
      "pnpm dlx rimraf /other",
      "yarn dlx rimraf /other",
      "bunx rimraf /other",
      "uv run rm -rf /other",
      `uv run python -c "import shutil; shutil.rmtree('/other')"`,
    ]);
  });

  it("leaves ordinary runs, and remote ones, alone", () => {
    neverAsks([
      "npx prettier --write src",
      "npx tsc --noEmit",
      "npx rimraf dist",
      "pnpm exec vitest run",
      "pnpm dlx shadcn@latest add button",
      "uv run pytest",
      "timeout 30 pnpm test",
      "watch -n1 ls",
      "ssh host rm -rf /other",
    ]);
  });
});

describe("more tools that write", () => {
  it("names the files they write", () => {
    expect(toolWrites("curl", ["-sSLo", "a", "https://x"])).toEqual(["a"]);
    expect(toolWrites("curl", ["--output=a", "https://x"])).toEqual(["a"]);
    expect(toolWrites("curl", ["-o", "/dev/null", "https://x"])).toEqual([]);
    expect(toolWrites("wget", ["-qO-", "https://x"])).toEqual([]);
    expect(toolWrites("wget", ["-P", "d", "https://x"])).toEqual(["d"]);
    expect(toolWrites("sort", ["-o", "a", "b"])).toEqual(["a"]);
    expect(toolWrites("patch", ["-p1", "-o", "a"])).toEqual(["a"]);
    expect(toolWrites("gzip", ["-9", "a", "b"])).toEqual(["a", "b"]);
    expect(toolWrites("gzip", ["-dc", "a"])).toEqual([]);
    expect(toolWrites("mkfifo", ["-m", "600", "p"])).toEqual(["p"]);
    expect(toolWrites("sqlite3", ["db", "select 1"])).toEqual(["db"]);
    expect(toolWrites("sqlite3", ["-readonly", "db"])).toEqual([]);
    expect(gitWrites(["config", "--file", "c", "user.name", "x"])).toEqual(["c"]);
    expect(gitWrites(["config", "--file", "c", "--get", "user.name"])).toEqual([]);
    expect(gitWrites(["submodule", "add", "-b", "main", "https://x/r", "sub"])).toEqual(["sub"]);
    expect(gitWrites(["checkout-index", "--prefix=out/", "-a"])).toEqual(["out/"]);
  });

  it("asks when they write outside the worktree", () => {
    asksAtBoth([
      "curl -o /other/x https://example.com",
      "curl -sSLo /other/x https://example.com",
      "curl --output /other/x https://example.com",
      "wget -O /other/x https://example.com",
      "wget -P /other https://example.com",
      "sort -o /other/x a",
      "sort --output=/other/x a",
      "patch -o /other/x a b",
      "gzip /other/x",
      "gunzip /other/x.gz",
      "xz -d /other/x.xz",
      "mkfifo /other/p",
      "sqlite3 /other/db.sqlite 'delete from t'",
      "sqlite3 /home/me/.agent-rishi/agent-rishi.db .tables",
      "git config --file /other/.gitconfig user.name x",
      "git submodule add https://example.com/r /other/sub",
      "git checkout-index --prefix=/other/ -a",
    ]);
  });

  it("doesn't ask inside the worktree or for output that is thrown away", () => {
    neverAsks([
      "curl -o ./x.json https://example.com",
      "curl -s https://example.com -o /dev/null",
      'curl -H "Accept: x" https://example.com',
      "wget -qO- https://example.com",
      "sort -o out.txt in.txt",
      "gzip -c file > out.gz",
      "gzip file",
      "sqlite3 dev.db 'select 1'",
      "sqlite3 :memory: 'select 1'",
      "git config user.name x",
      "git config --get user.name",
    ]);
  });
});
