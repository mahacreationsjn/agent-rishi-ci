import type { RiskAssessment } from "./assessment";
import { binName, unwrap } from "./command-words";
import { SEARCHES } from "./search-words";
import { asPath, braceAlternatives, DATA, LISTS, runsOnFound } from "./secrets";
import { type SimpleCommand, wordPaths } from "./shell";

/**
 * Finding the files one shell command writes, for files whose every write is judged (agents'
 * allow-lists, `./agent-permissions`; Agent Rishi's project config, `./project-config`).
 */

/** Interpreters whose inline code may write a file (`node -e "fs.writeFileSync(…)"`). */
const INTERPRETERS = new Set([
  "node",
  "nodejs",
  "deno",
  "bun",
  "python",
  "python3",
  "py",
  "perl",
  "ruby",
  "php",
]);

/** Commands that only read, list, search, delete or move between folders: none writes one. */
const NO_WRITE = new Set([
  ...DATA,
  ...SEARCHES,
  "cat",
  "type",
  "get-content",
  "gc",
  "head",
  "tail",
  "less",
  "more",
  "bat",
  "wc",
  "diff",
  "cmp",
  "file",
  "jq",
  "cd",
  "pushd",
  "chdir",
  "set-location",
  "sl",
  "push-location",
  "mkdir",
  "md",
  "rm",
  "rmdir",
  "del",
  "erase",
  "rd",
  "remove-item",
  "ri",
  "unlink",
]);

/** Git commands that write files named in their arguments. */
const GIT_WRITES = new Set(["checkout", "restore", "mv"]);

/** Whether the command may write the paths its arguments name. */
function writesArguments(bin: string, args: readonly string[]): boolean {
  if (LISTS.has(bin)) return runsOnFound(bin, args);
  if (NO_WRITE.has(bin)) return false;
  if (bin !== "git") return true;
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i] as string;
    if (arg === "-C" || arg === "-c") i += 1;
    else if (!arg.startsWith("-")) return GIT_WRITES.has(arg);
  }
  return false;
}

/** How `commandWrite` judges what a command writes. */
export interface WriteChecks {
  /** The verdict on writing this path, or undefined when it isn't one of the files. */
  write: (path: string) => RiskAssessment | undefined;
  /** The verdict on inline code (`node -e`, `[IO.File]::…`) that names one of the files. */
  mention: (code: string) => RiskAssessment | undefined;
}

/**
 * One simple command's write of a file `checks` cares about: a redirect onto one, inline code
 * that names one (`node -e`, `python -c`, a PowerShell `[IO.File]::WriteAllText(…)`), or an
 * argument that is one, for any command that may write its arguments (`tee`, `cp`, `mv`,
 * `sed -i`, `dd of=<file>`, `Set-Content`, `Copy-Item`, `git checkout -- <file>`, ...). Reads,
 * searches, listings and deletions don't count.
 */
export function commandWrite(cmd: SimpleCommand, checks: WriteChecks): RiskAssessment | undefined {
  for (const target of cmd.writes) {
    const found = checks.write(target);
    if (found) return found;
  }
  const { tokens } = unwrap(cmd.words);
  const bin = binName(tokens[0]);
  const args = tokens.slice(1);
  if (INTERPRETERS.has(bin) || tokens[0]?.startsWith("[")) {
    const named = checks.mention(tokens.join(" "));
    if (named) return named;
  }
  if (!writesArguments(bin, args)) return undefined;
  for (const arg of args) {
    for (const word of wordPaths(cmd, arg)) {
      for (const alt of braceAlternatives(word)) {
        // `dd`'s operands are `name=value`: `of=` names the file it writes.
        const path = bin === "dd" && /^of=./i.test(alt) ? alt.slice(3) : asPath(alt);
        const found = path === undefined ? undefined : checks.write(path);
        if (found) return found;
      }
    }
  }
  return undefined;
}
