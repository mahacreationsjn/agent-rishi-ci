import { type RiskAssessment, risky, SAFE } from "./assessment";
import { binName, unwrap } from "./command-words";
import { isWin, isWritable, type PathContext, providerPath, SHELL_DRIVES } from "./paths";
import { findPaths, readFd, readFind, xargsCommand } from "./search-runs";
import { type ShellDialect, type SimpleCommand, wordPaths } from "./shell";
import { UNRESOLVED, unresolvedTarget } from "./variables";

/**
 * Deletes outside the worktree (§11.2). `rm`, `del`, `Remove-Item` and their kin ask when they
 * name the filesystem root or a path outside where the agent may write (the worktree, the extra
 * roots, a folder in the OS temp directory). So do `xargs rm …` and a `ForEach-Object` block that
 * runs `Remove-Item`.
 *
 * A delete fed by a pipe (#449) removes what the pipeline hands it: `Get-ChildItem C:\Users |
 * Remove-Item -Recurse` deletes in `C:\Users` like `Remove-Item -Recurse C:\Users\*` does, and so
 * do `… | ForEach-Object { Remove-Item $_ }` and `… | xargs rm`. The command at the head of the
 * pipeline is checked: the paths it names, or the current directory for a listing that names
 * none (`Get-ChildItem -Recurse`, `find -name x`). Stages in between (`Where-Object`, `grep`,
 * `Select-Object -First 5`) only pass items on, and are not read as paths.
 *
 * A search that deletes what it finds (#518: `find X -delete`, `find X -exec rm {} +`,
 * `fd . X -x rm`) deletes under the folders it searches, like `find X | xargs rm`. A registry key
 * or certificate (`Remove-Item HKCU:\Software\Foo`, or `Remove-Item Foo` after
 * `cd HKCU:\Software`) is never in the worktree; PowerShell's `Env:`, `Variable:`, `Function:` and
 * `Alias:` drives only hold the running shell's own state, so deleting there runs freely.
 * `reg delete` is judged with the other `reg` commands (`./registry`).
 *
 * A word like `/s` is a switch only to cmd's own commands (`del /q`, `rd /s`, `dir /b`), and only
 * where cmd may be the shell. Everywhere else it is a path: `/c` is the `C:` drive in Git Bash.
 */

/** The context of a delete: the paths, and the shell the command runs in when it is known. */
export type DeleteContext = PathContext & { shell?: ShellDialect };

/** Commands that delete the paths they are given. */
const DELETES = new Set([
  "rm",
  "rmdir",
  "del",
  "erase",
  "rd",
  "remove-item",
  "ri",
  "remove-itemproperty",
  "rp",
  "unlink",
  "shred",
  "rimraf",
  "del-cli",
]);
/** cmd's own commands, and the switches each takes. */
const CMD_SWITCHES = new Map<string, RegExp>([
  ["del", /^\/(?:[pfsq]|a(?::.*)?)$/i],
  ["erase", /^\/(?:[pfsq]|a(?::.*)?)$/i],
  ["rd", /^\/[sq]$/i],
  ["rmdir", /^\/[sq]$/i],
  ["dir", /^\/[a-z](?::.*)?$/i],
]);

/** The words `bin` takes as switches: cmd's, on Windows, unless the shell is known not to be cmd. */
function switchesOf(bin: string, ctx: DeleteContext): RegExp | undefined {
  if (!isWin(ctx) || ctx.shell === "posix" || ctx.shell === "powershell") return undefined;
  return CMD_SWITCHES.get(bin);
}
/** Listings: what they output lies under the paths they name, or the current directory. */
const LISTINGS = new Set(["get-childitem", "gci", "ls", "dir", "get-item", "gi", "find"]);
/** Listing parameters whose value is a pattern or a number, not a path. */
const PATTERN_PARAMS = new Set(["-filter", "-include", "-exclude", "-depth", "-attributes"]);
const FOREACH = new Set(["foreach-object", "%", "foreach"]);

/**
 * The delete risk of `cmd`: the paths it deletes itself and, when it reads a pipe, those the
 * command at the head of its pipeline (`source`) lists or names.
 */
export function classifyDelete(
  cmd: SimpleCommand,
  ctx: DeleteContext,
  source?: SimpleCommand,
): RiskAssessment {
  const { tokens } = unwrap(cmd.words);
  const bin = binName(tokens[0]);
  const args = tokens.slice(1);
  if (bin === "find" || bin === "fd") return searchDelete(cmd, bin, args, ctx);
  const own = deletedPaths(cmd, bin, args, ctx);
  if (!own) return SAFE;
  for (const target of own) {
    const where = outside(target, ctx, cmd);
    if (where !== undefined) return risky("outside_worktree", `Deletes ${target}${where}`);
  }
  if (!source) return SAFE;
  for (const target of listedPaths(source, ctx)) {
    const where = outside(target, ctx, source);
    if (where !== undefined) {
      return risky("outside_worktree", `Deletes what a pipe lists from ${target}${where}`);
    }
  }
  return SAFE;
}

/**
 * Why deleting `target` asks: `""` for the filesystem root, `", outside the worktree"` for a path
 * the agent may not write, a registry key or a certificate, or one a variable of `cmd` only names
 * when it runs (`./variables`). Undefined when it may delete it. `*` empties the current
 * directory: fine in the worktree or a folder in temp.
 */
function outside(target: string, ctx: PathContext, cmd?: SimpleCommand): string | undefined {
  if (cmd && unresolvedTarget(cmd, target, ctx)) return `, ${UNRESOLVED}`;
  const provider = providerPath(target, ctx);
  if (provider?.path !== undefined) return outside(provider.path, ctx);
  if (provider) return SHELL_DRIVES.has(provider.drive) ? undefined : ", outside the worktree";
  if (/^[\\/]$/.test(target) || /^[a-z]:[\\/]?$/i.test(target)) return "";
  return isWritable(target === "*" ? "." : target, ctx) ? undefined : ", outside the worktree";
}

/** The paths `cmd` deletes by name, or undefined when it deletes nothing. */
function deletedPaths(
  cmd: SimpleCommand,
  bin: string,
  args: string[],
  ctx: DeleteContext,
): string[] | undefined {
  if (DELETES.has(bin)) return operands(cmd, args, switchesOf(bin, ctx));
  if (bin === "xargs") {
    const inner = unwrap(xargsCommand(args)).tokens;
    const tool = binName(inner[0]);
    return DELETES.has(tool) ? operands(cmd, inner.slice(1), switchesOf(tool, ctx)) : undefined;
  }
  if (FOREACH.has(bin)) {
    // The words of `{ Remove-Item $_.FullName -Recurse }`, without the braces.
    const words = args.map((w) => w.replace(/^\{+/, "").replace(/[};]+$/, "")).filter(Boolean);
    const at = words.findIndex((w) => DELETES.has(w.toLowerCase()));
    if (at < 0) return undefined;
    return operands(cmd, words.slice(at + 1), switchesOf((words[at] as string).toLowerCase(), ctx));
  }
  return undefined;
}

/**
 * The risk of a `find` or `fd` that deletes what it finds (`-delete`, or a delete command run by
 * `-exec`, `-execdir`, `-ok`, `-okdir`, `fd -x`, `fd -X`): it deletes under the folders it
 * searches, the current directory when it names none. The paths the delete command names itself
 * (`-exec rm -rf /var/cache/{} \;`) are checked too.
 */
function searchDelete(
  cmd: SimpleCommand,
  bin: string,
  args: string[],
  ctx: DeleteContext,
): RiskAssessment {
  const search = bin === "find" ? readFind(args) : readFd(args);
  let deletes = search.deletes;
  const named: string[] = [];
  for (const run of search.runs) {
    const inner = unwrap(run).tokens;
    const tool = binName(inner[0]);
    if (!DELETES.has(tool)) continue;
    deletes = true;
    named.push(...operands(cmd, inner.slice(1), switchesOf(tool, ctx)).filter((p) => p !== "{}"));
  }
  if (!deletes) return SAFE;
  for (const root of search.roots.length > 0 ? search.roots : ["."]) {
    const where = outside(root, ctx, cmd);
    if (where !== undefined) {
      return risky("outside_worktree", `Deletes what ${bin} finds in ${root}${where}`);
    }
  }
  for (const target of named) {
    const where = outside(target, ctx, cmd);
    if (where !== undefined) return risky("outside_worktree", `Deletes ${target}${where}`);
  }
  return SAFE;
}

/**
 * The paths a command lists or names, for the delete (or item write, `./item-writes`) it feeds. A
 * listing that names none lists the current directory. `find`'s paths are the words before its
 * expression.
 */
export function listedPaths(source: SimpleCommand, ctx: DeleteContext): string[] {
  const { tokens } = unwrap(source.words);
  // PowerShell: strings at the head of a pipe are the items themselves (`'C:\x','C:\y' | ri`).
  const text = (word: string) => source.quoted?.has(word) === true || ARRAY.test(word);
  if (ctx.shell !== "posix" && tokens.length > 0 && tokens.every(text)) {
    return tokens.flatMap((word) => wordPaths(source, word)).flatMap(arrayItems);
  }
  const bin = binName(tokens[0]);
  const args = tokens.slice(1);
  const paths =
    bin === "find"
      ? findPaths(args)
      : operands(
          source,
          args.filter((_, k) => !PATTERN_PARAMS.has(args[k - 1]?.toLowerCase() ?? "")),
          switchesOf(bin, ctx),
        );
  return paths.length > 0 || !LISTINGS.has(bin) ? paths : ["."];
}

/** PowerShell's array of strings: `@('a','b')`. */
const ARRAY = /^@\((.*)\)$/s;

/** The strings of a PowerShell array, or the word itself. */
function arrayItems(word: string): string[] {
  const array = ARRAY.exec(word);
  if (!array) return [word];
  return [...(array[1] as string).matchAll(/'([^']*)'|"([^"]*)"/g)].map((m) => m[1] ?? m[2] ?? "");
}

/**
 * The path words among `args`: not options or the command's cmd `switches` (`/s`), with
 * PowerShell's bound `-Path:x` and `-LiteralPath:x`, and each element of a PowerShell list (`a,b`).
 */
function operands(cmd: SimpleCommand, args: string[], switches?: RegExp): string[] {
  const paths: string[] = [];
  for (const arg of args) {
    const bound = /^-(path|literalpath|lp):/i.exec(arg);
    if (bound) paths.push(...wordPaths(cmd, arg, bound[0].length));
    else if (!arg.startsWith("-") && !switches?.test(arg)) paths.push(...wordPaths(cmd, arg));
  }
  return paths;
}
