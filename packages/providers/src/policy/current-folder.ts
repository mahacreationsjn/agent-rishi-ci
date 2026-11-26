import type { ShellDialect } from "./shell-builder";

/**
 * Where the shell is, as a command line names it (§11.2, #663): `$PWD`, `${PWD}`, `$(pwd)` and
 * `` `pwd` `` in a POSIX shell (`pwd -L` and `pwd -P` too); PowerShell's `$PWD` in any case (with
 * `.Path`), `(Get-Location)`, `(pwd)` and `(gl)`, with or without `$`; and cmd's `%CD%`. At the
 * start of a path, `./paths` puts that folder in their place, so `cd "$(pwd)/apps/web"` stays in
 * the worktree and `rm -rf "$(pwd)/../x"` deletes beside it.
 *
 * Only where the shell would print that folder:
 * - the forms of the command's own shell. A POSIX shell has no `$pwd` (it is empty, so `"$pwd/x"`
 *   is `/x`) and runs no `Get-Location`; PowerShell has no `` `pwd` ``. When the shell isn't known,
 *   only the forms both read alike, PowerShell's in parentheses, and on Windows cmd's `%CD%`;
 * - followed by the end of the path or a separator: `$PWD../x` names a folder beside it;
 * - while the command line can't change what they print (`redefines`): it defines no function or
 *   alias for them, switches no builtin and reads no script, module or string into the shell.
 */

/** What the folder checks know of the command: its shell, platform and what it redefines. */
export interface FolderNaming {
  shell?: ShellDialect;
  platform?: NodeJS.Platform;
  redefines?: boolean;
}

/** Read alike by a POSIX shell and PowerShell. */
const BOTH = /^(?:\$PWD|\$\{PWD\}|\$\(\s*pwd\s*\))/;
/**
 * PowerShell's, where a POSIX shell refuses the whole line (`cd (Get-Location)` is a syntax error
 * there). Not `$(Get-Location)`, which a POSIX shell runs as a missing command: empty, so
 * `"$(Get-Location)/x"` is `/x`.
 */
const PARENTHESES = /^\(\s*(?:pwd|gl|get-location)\s*\)(?:\.(?:path|providerpath))?/i;
/** A POSIX shell: names are case-sensitive. */
const POSIX = /^(?:\$PWD|\$\{PWD\}|\$\(\s*pwd(?:\s+-[LP])?\s*\)|`\s*pwd(?:\s+-[LP])?\s*`)/;
/** PowerShell, in any case. */
const POWERSHELL =
  /^(?:\$(?:PWD|\{PWD\})|\$?\(\s*(?:\$PWD(?:\.Path)?|pwd|gl|Get-Location)\s*\))(?:\.(?:Path|ProviderPath))?/i;
/** cmd, in any case. */
const CMD = /^%CD%/i;
/** Any of them, in any shell and any case: a path that starts so names where the shell is. */
const ANY = /^(?:\$\{?pwd\}?|\$?\(\s*(?:\$pwd|pwd|gl|get-location)\b|`\s*pwd\b|%cd%)/i;

/**
 * How long the name of where the shell is that `value` (a path, its quotes taken off) starts with
 * is, when its shell reads it so and it is followed by the end or a separator; 0 otherwise.
 */
export function currentFolderLength(value: string, ctx: FolderNaming): number {
  if (ctx.redefines) return 0;
  const win = (ctx.platform ?? process.platform) === "win32";
  const shell = ctx.shell ?? "auto";
  const found =
    shell === "posix"
      ? POSIX.exec(value)
      : shell === "powershell"
        ? POWERSHELL.exec(value)
        : (BOTH.exec(value) ?? PARENTHESES.exec(value) ?? (win ? CMD.exec(value) : null));
  if (!found) return 0;
  const length = found[0].length;
  const next = value[length];
  return next === undefined || next === "/" || (win && next === "\\") ? length : 0;
}

/** True when `value` starts like a name of where the shell is, whether or not it is one. */
export const namesCurrentFolder = (value: string): boolean => ANY.test(value);

/** Where a command starts: a line, or after `;`, `&`, `|`, `(` or `{`, also run by `builtin`. */
const AT_COMMAND = String.raw`(?:^|[;&|({])\s*(?:(?:builtin|command)\s+)?`;

/**
 * What may change what `pwd`, `Get-Location`, `gl` or `git` do: a function for one of them
 * (`pwd() {`, `function git`, `function global:Get-Location`); an alias or a builtin switched on or
 * off; a script, a module or a string read into the shell itself (`source`, `.`, `eval`,
 * `Import-Module`, `iex`), which may define either; and PowerShell's `Function:` and `Alias:`
 * drives.
 */
const REDEFINES = [
  /(?:^|[^\w-])(?:pwd|gl|get-location|git)\s*\(\s*\)/i,
  /\b(?:function|filter)\s+(?:\w+:)?(?:pwd|gl|get-location|git)(?![\w-])/i,
  new RegExp(`${AT_COMMAND}(?:alias|unalias|enable|source|\\.|eval|sal|nal|ipmo|iex)(?=\\s)`, "im"),
  /\b(?:set-alias|new-alias|import-module|invoke-expression)\b/i,
  /\b(?:function|alias):/i,
];

/**
 * True when `command` may change what `pwd`, `Get-Location` or `git` print, so neither where the
 * shell is nor the repository's top folder (`./locations`) can be told from it.
 */
export const redefinesFolderCommands = (command: string): boolean =>
  REDEFINES.some((pattern) => pattern.test(command));
