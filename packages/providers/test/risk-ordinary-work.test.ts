import type { AutonomyLevel } from "@agent-rishi/contracts";
import { describe, expect, it } from "vitest";
import type { AcpToolState } from "../src/acp/items";
import { AcpPolicy } from "../src/acp/policy";
import { ClaudePolicy } from "../src/claude/permissions";
import { commandRisk, levelAllows, patchRisk } from "../src/codex/policy";
import { OpenCodePolicy } from "../src/opencode/policy";
import type { RiskContext } from "../src/policy/risk";

/**
 * Ordinary work in the session's own worktree asks at neither Full nor Auto, through every
 * provider's permission path (#663, #655). Session worktrees live in Agent Rishi's home
 * (`~/.agent-rishi/wt/<project>/<id>`), where everything else asks at every level, and on Windows
 * agents name the worktree as `C:\…`, `c:/…`, Git Bash's `/c/…` or in PowerShell.
 */

const OWN = "agent-rishi/fix-x";
const WIN_TREE = "C:\\Users\\me\\.agent-rishi\\wt\\proj\\abcd";
const GIT_BASH_TREE = "/c/Users/me/.agent-rishi/wt/proj/abcd";
const POSIX_TREE = "/home/me/.agent-rishi/wt/proj/abcd";

const win: RiskContext = {
  cwd: WIN_TREE,
  platform: "win32",
  home: "C:\\Users\\me",
  tempRoots: ["C:\\Users\\me\\AppData\\Local\\Temp"],
  agentRishiHome: "C:\\Users\\me\\.agent-rishi",
  artifactsDir: "C:\\Users\\me\\.agent-rishi\\artifacts\\s1",
  notesRoots: ["C:\\Users\\me\\.claude\\plans"],
  ownBranch: OWN,
  currentBranch: () => OWN,
  env: {},
};
const posix: RiskContext = {
  cwd: POSIX_TREE,
  platform: "linux",
  home: "/home/me",
  tempRoots: ["/tmp"],
  agentRishiHome: "/home/me/.agent-rishi",
  artifactsDir: "/home/me/.agent-rishi/artifacts/s1",
  ownBranch: OWN,
  currentBranch: () => OWN,
  env: {},
};

/** The worktree as agents write it on Windows: as given, lower case, forward slashes, Git Bash. */
const WIN_FORMS = [
  WIN_TREE,
  "c:\\users\\me\\.agent-rishi\\wt\\proj\\abcd",
  "c:/Users/me/.agent-rishi/wt/proj/abcd",
  GIT_BASH_TREE,
];

/** Everyday commands of a POSIX shell (Git Bash on Windows) in the worktree `w`. */
const shellWork = (w: string) => [
  `cd "${w}" && pnpm test`,
  `cd "${w}" && pnpm install`,
  `cd "${w}" && git status`,
  `cd "${w}" && git add -A && git commit -m "fix: x"`,
  "git commit -F - <<'EOF'\nfix: x\n\nBody.\nEOF",
  `cd "${w}" && git commit -m "$(cat <<'EOF'\nfix: x\nEOF\n)"`,
  "cat <<'EOF' > src/x.ts\nexport const x = 1;\nEOF",
  `git push origin ${OWN}`,
  `cd "${w}" && git push -u origin ${OWN}`,
  "npx tsc --noEmit",
  "node script.js",
  "python -m pytest",
  "mkdir -p src/x",
  "rm -rf dist",
  `rm -rf "${w}/dist"`,
  "pnpm test 2>&1 | tail -50",
  `cd "${w}" && pnpm test 2>&1 | tail -n 30`,
  'cd "$(pwd)/apps/web" && pnpm build',
  'echo "built in $(pwd)" > build.log',
  "go test ./...",
  `node -e "process.stdout.write('...')"`,
];

/** Everyday PowerShell commands in the worktree `w`. */
const psWork = (w: string) => [
  `Set-Location "${w}"; pnpm test`,
  `Set-Location -Path "${w}"; git status`,
  `Set-Location "${w}"; git add -A; git commit -m "fix: x"`,
  "pnpm test 2>&1 | Select-Object -Last 20",
  "New-Item -ItemType Directory -Force src\\x",
  "Remove-Item -Recurse -Force dist",
  `Set-Content -Path "${w}\\src\\x.ts" -Value "x"`,
  "Set-Location (Get-Location); pnpm test",
  'Set-Location "$PWD\\apps\\web"; pnpm build',
  "@'\nfix: x\n'@ | git commit -F -",
];

const files = (w: string) => [`${w}/src/x.ts`, "src/x.ts", "src\\x.ts"];

const LEVELS: AutonomyLevel[] = ["full", "auto"];

describe("ordinary work in a worktree under Agent Rishi's home asks at no level (#663)", () => {
  it("Claude: Bash, PowerShell, Edit and Write, on Windows", () => {
    for (const level of LEVELS) {
      const p = new ClaudePolicy(level, win);
      // Claude reports the shell's folder in either form once a command has run.
      for (const dir of [undefined, WIN_TREE, GIT_BASH_TREE]) {
        for (const w of WIN_FORMS) {
          for (const command of shellWork(w)) {
            expect(p.gate("Bash", { command }, dir), `${level} ${command}`).toEqual({ ask: false });
          }
          for (const file_path of files(w)) {
            for (const tool of ["Edit", "Write"]) {
              expect(p.gate(tool, { file_path }, dir), `${level} ${file_path}`).toEqual({
                ask: false,
              });
            }
          }
        }
        for (const w of WIN_FORMS.slice(0, 3)) {
          for (const command of psWork(w)) {
            expect(p.gate("PowerShell", { command }, dir), `${level} ${command}`).toEqual({
              ask: false,
            });
          }
        }
      }
    }
  });

  it("Claude: Bash, Edit and Write, on POSIX", () => {
    for (const level of LEVELS) {
      const p = new ClaudePolicy(level, posix);
      for (const command of shellWork(POSIX_TREE)) {
        expect(p.gate("Bash", { command }), `${level} ${command}`).toEqual({ ask: false });
      }
      for (const file_path of files(POSIX_TREE).slice(0, 2)) {
        expect(p.gate("Write", { file_path }), `${level} ${file_path}`).toEqual({ ask: false });
      }
    }
  });

  it("Codex: commands (also run by PowerShell) and patches", () => {
    const pwsh = (script: string) =>
      `"C:\\WINDOWS\\System32\\WindowsPowerShell\\v1.0\\powershell.exe" -Command '${script.replace(/'/g, "''")}'`;
    for (const level of LEVELS) {
      for (const w of WIN_FORMS.slice(0, 3)) {
        const commands = [...shellWork(w), ...psWork(w).map(pwsh)];
        for (const command of commands) {
          for (const cwd of [undefined, WIN_TREE]) {
            const risk = commandRisk([command], win, { cwd });
            expect(levelAllows(level, risk), `${level} ${command}`).toBe(true);
          }
        }
        for (const file of files(w)) {
          expect(levelAllows(level, patchRisk([file], undefined, win)), file).toBe(true);
        }
      }
      for (const command of shellWork(POSIX_TREE)) {
        const risk = commandRisk([command], posix, { cwd: POSIX_TREE });
        expect(levelAllows(level, risk), `${level} ${command}`).toBe(true);
      }
    }
  });

  it("OpenCode: shell and edit asks", () => {
    for (const level of LEVELS) {
      for (const [ctx, forms] of [
        [win, WIN_FORMS.slice(0, 3)],
        [posix, [POSIX_TREE]],
      ] as const) {
        const p = new OpenCodePolicy(level, ctx);
        for (const w of forms) {
          for (const command of shellWork(w)) {
            const decision = p.decide({
              request: { id: "p", sessionID: "s", action: "shell", resources: [command] },
              toolName: "bash",
              toolInput: { command, workdir: ctx.cwd },
            });
            expect(decision, `${level} ${command}`).toEqual({ kind: "allow" });
          }
          for (const file of files(w)) {
            const decision = p.decide({
              request: { id: "p", sessionID: "s", action: "edit", resources: [file] },
              toolName: "edit",
              toolInput: { path: file },
            });
            expect(decision, `${level} ${file}`).toEqual({ kind: "allow" });
          }
        }
      }
    }
  });

  it("ACP agents: execute and edit asks", () => {
    const call = (state: Partial<AcpToolState>) => ({ toolCallId: "t", ...state }) as AcpToolState;
    for (const level of LEVELS) {
      for (const [ctx, forms] of [
        [win, WIN_FORMS.slice(0, 3)],
        [posix, [POSIX_TREE]],
      ] as const) {
        const p = new AcpPolicy(level, ctx);
        for (const w of forms) {
          for (const command of shellWork(w)) {
            const decision = p.decide(call({ kind: "execute", rawInput: { command } }));
            expect(decision, `${level} ${command}`).toEqual({ kind: "allow" });
          }
        }
      }
      // Edits resolve with this machine's own paths.
      const native = process.platform === "win32" ? win : posix;
      const p = new AcpPolicy(level, native);
      for (const file of files(native.cwd).slice(0, 2)) {
        const decision = p.decide(call({ kind: "edit", rawInput: { path: file } }));
        expect(decision, `${level} ${file}`).toEqual({ kind: "allow" });
      }
    }
  });

  it("still asks at every level for Agent Rishi's home outside the worktree", () => {
    for (const level of LEVELS) {
      const p = new ClaudePolicy(level, win);
      for (const command of [
        "cat /c/Users/me/.agent-rishi/runner/runner.json",
        'cd "C:\\Users\\me\\.agent-rishi\\wt\\proj\\other" && git status',
        'rm -rf "$(pwd)/../other"',
      ]) {
        expect(p.gate("Bash", { command }), `${level} ${command}`).toMatchObject({ ask: true });
      }
      expect(
        p.gate("Write", { file_path: "C:\\Users\\me\\.agent-rishi\\settings.json" }),
      ).toMatchObject({ ask: true });
    }
  });
});
