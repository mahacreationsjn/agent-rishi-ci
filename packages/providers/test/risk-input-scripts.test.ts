import { describe, expect, it } from "vitest";
import { levelAllows } from "../src/codex/policy";
import { classifyCommand, type RiskContext } from "../src/policy/risk";

/**
 * Paths and scripts a command line only shows when it is read the way its shell reads it:
 * one-letter root paths, scripts fed to a shell or an interpreter on its input, substitutions in
 * a heredoc, variables in write targets and escaped program names.
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
const gitBash: RiskContext = { ...win, shell: "posix" };
const unknown: RiskContext = { ...win, shell: "auto" };
const ps: RiskContext = { ...win, shell: "powershell" };

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
const lines = (...text: string[]) => text.join("\n");

describe("one-letter root paths", () => {
  it("reads /x as a path for POSIX tools", () => {
    asksAtBoth(["rm -rf /c", "rm -rf /o", "rm -rf /c/", "rm -rf /s", "rmdir /c"], gitBash);
    asksAtBoth(["rm -rf /c", "rm -rf /s", "ls /c | xargs rm -rf"], unknown);
    asksAtBoth(["rm -rf /o", "rmdir /s"]);
    asksAtBoth(["rm -r -fo /c"], ps);
  });

  it("reads a switch only for cmd's own commands, and only the switches they take", () => {
    neverAsks(["rmdir /s /q build", "rd /s /q dist", "del /f /q x.txt", "dir /b"], unknown);
    neverAsks(['cmd //c "rd /s /q dist"'], gitBash);
    neverAsks(['cmd /c "rd /s /q dist"'], ps);
    asksAtBoth(["rmdir /c", "del /c", "rd /s /q /c"], unknown);
  });
});

describe("scripts read on the input", () => {
  it("classifies a script that is written out", () => {
    asksAtBoth([
      "echo 'rm -rf /other' | sh",
      "echo 'rm -rf /other' | bash -",
      "echo 'rm -rf /other' | sudo bash",
      "echo 'rm -rf /other' | zsh",
      "printf 'rm -rf /other\\n' | sh",
      "bash <<< 'rm -rf /other'",
      "bash -s <<< 'rm -rf /other'",
      lines("bash <<EOF", "rm -rf /other", "EOF"),
      lines("sh <<'EOF'", "rm -rf /other", "EOF"),
      lines("cat <<'EOF' | sh", "rm -rf /other", "EOF"),
      "source <(echo 'rm -rf /other')",
      ". <(echo 'rm -rf /other')",
      "sh < <(echo 'rm -rf /other')",
      "echo 'cat /home/me/.agent-rishi/install.json' | sh",
    ]);
    asksAtBoth(["echo 'Remove-Item C:\\other -Recurse' | pwsh -Command -"], ps);
  });

  it("classifies code an interpreter reads", () => {
    asksAtBoth([
      lines("python - <<EOF", "import shutil; shutil.rmtree('/other')", "EOF"),
      lines("python3 <<'EOF'", "import os", "os.system('rm -rf /other')", "EOF"),
      `echo "import shutil; shutil.rmtree('/other')" | python3`,
      `echo "require('fs').rmSync('/other',{recursive:true})" | node -`,
    ]);
  });

  it("asks for a script that is only known when it runs", () => {
    asksAtAuto([
      "cat script.sh | bash",
      "base64 -d <<< cm0gLXJmIC9vdGhlcg== | sh",
      "echo cm0= | base64 -d | bash",
      "cat gen.py | python3",
      "source <(./gen.sh)",
    ]);
  });

  it("leaves ordinary input alone", () => {
    neverAsks([
      lines("cat <<EOF > notes.md", "hello", "EOF"),
      lines("python3 - <<'EOF'", "print(1)", "EOF"),
      lines("python3 <<'EOF'", "open('out.json','w').write('x')", "EOF"),
      lines("bash <<'EOF'", "set -e", "pnpm build", "EOF"),
      `echo '{"a":1}' | python3 -m json.tool`,
      "echo hi | node -e 'console.log(1)'",
      'echo "ls src" | bash',
      "cat data.json | node scripts/read.mjs",
      "ssh host rm -rf /other",
    ]);
  });
});

describe("substitutions in a heredoc", () => {
  it("classifies what an unquoted body runs", () => {
    asksAtBoth([
      lines("cat <<EOF", "$(rm -rf /other)", "EOF"),
      lines("cat <<EOF", "`rm -rf /other`", "EOF"),
      lines("cat <<-EOF", "\t$(rm -rf /other)", "\tEOF"),
      lines("cat << EOF > x.txt", "today $(rm -rf /other)", "EOF"),
    ]);
  });

  it("leaves a quoted body, and harmless substitutions, alone", () => {
    neverAsks([
      lines("cat <<'EOF'", "$(rm -rf /other)", "EOF"),
      lines('cat <<"EOF"', "$(rm -rf /other)", "EOF"),
      lines("cat <<\\EOF", "$(rm -rf /other)", "EOF"),
      lines("cat <<EOF > notes.md", "built $(date)", "EOF"),
      lines(`git commit -m "$(cat <<'EOF'`, "fix: a thing", "EOF", ')"'),
    ]);
  });
});

describe("variables in write targets", () => {
  it("fills in what the command line assigned", () => {
    asksAtBoth([
      "x=/other; rm -rf $x",
      'X=/other; rm -rf "$X"/sub',
      `export X=/other; rm -rf $\{X}`,
      "x=/other; echo hi > $x/file",
      "x=/other; cp a $x",
      "x=/other; eval 'rm -rf $x'",
      lines("x=/other; bash <<EOF", "rm -rf $x", "EOF"),
      "for d in /other src; do rm -rf $d; done",
    ]);
    asksAtBoth(
      ["$p = 'C:\\other'; Remove-Item -Recurse $p", "$p='C:\\other'; Set-Content $p\\x.txt hi"],
      ps,
    );
  });

  it("keeps every value a variable may hold", () => {
    asksAtBoth([
      "x=/tmp/a; x=/other; rm -rf $x",
      'x=/tmp/a; if true; then x=/other; fi; rm -rf "$x"',
      'x=/tmp/a; read x; rm -rf "$x"',
      'x=/tmp/a; x+=/../../other; rm -rf "$x"',
    ]);
  });

  it("asks for a target that is still a variable or a parameter", () => {
    asksAtBoth([
      'f() { rm -rf "$1"; }; f /other',
      "rm -rf $UNSET/",
      'rm -rf "$@"',
      'echo x > "$out"',
      'cp a "$dest"',
    ]);
    asksAtBoth(["$x = Get-Location; Remove-Item -Recurse $x", "Remove-Item $target"], ps);
  });

  it("doesn't ask about reads, known folders or the command line's own temp files", () => {
    neverAsks([
      "x=src; ls $x",
      'cat "$f"',
      'for f in src/*.ts; do echo "$f"; done',
      'for f in a b; do touch "$f"; done',
      "out=dist; rm -rf $out",
      'rm -rf "$TMPDIR/x"',
      `rm -rf "$\{TMPDIR:-/tmp}/x"`,
      'ROOT=$(pwd); rm -rf "$ROOT/dist"',
      'tmp=$(mktemp -d); cp -r src "$tmp"; rm -rf "$tmp"',
      `tmp=$(mktemp); trap 'rm -f "$tmp"' EXIT; echo x > "$tmp"`,
      'OUT=$(mktemp); curl -s https://example.com -o "$OUT"; cat "$OUT"',
      "PORT=3000 pnpm dev",
      "rm 'src/routes/$id.tsx'",
    ]);
    neverAsks(
      [
        "$d = 'dist'; Remove-Item -Recurse $d",
        "$p = Join-Path $PWD 'x.txt'; Set-Content $p 'hi'",
        "$t = New-TemporaryFile; Set-Content $t 'x'",
        "Get-ChildItem *.log | ForEach-Object { Remove-Item $_ }",
        "Remove-Item $env:TEMP\\x -Recurse",
      ],
      ps,
    );
  });
});

describe("escaped program names when the shell is unknown", () => {
  it("reads the name the POSIX way on Windows", () => {
    asksAtBoth(["r\\m -rf /c/other", "sudo r\\m -rf C:\\other", "\\rm -rf /c/other"], unknown);
  });

  it("leaves Windows program paths alone", () => {
    neverAsks(
      ["C:\\tools\\cat.exe x", ".\\scripts\\build.cmd", "node_modules\\.bin\\tsc --noEmit"],
      unknown,
    );
  });
});
