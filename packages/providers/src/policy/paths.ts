import { realpathSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { currentFolderLength } from "./current-folder";
import { fromDevicePath } from "./device-paths";
import type { ShellDialect } from "./shell-builder";

export { isSecretPath } from "./secret-paths";

/** Context for path checks: the worktree plus any extra directories the agent may use. */
export interface PathContext {
  /** The session's working directory (worktree). */
  cwd: string;
  /**
   * The directory relative paths resolve against: the shell's current directory, or where a
   * `cd` earlier in the command moved. Defaults to `cwd`. Never widens the worktree.
   */
  dir?: string;
  /**
   * The PowerShell drive (or provider) the shell's location is on, lower-cased, when a `cd` earlier
   * in the command moved it off the filesystem (`cd HKCU:\Software`, `Set-Location Env:`). Relative
   * paths then name items on that drive, not files under `dir` (`./paths`' `providerPath`).
   */
  psDrive?: string;
  /**
   * Locations `pushd`/`Push-Location` saved earlier in the command, the latest last, for
   * `popd`/`Pop-Location` to go back to (`./locations`).
   */
  pushed?: readonly SavedLocation[];
  /**
   * True when the command sets `CDPATH`, which sends a `cd` to a relative folder (`cd other`) to
   * any folder it lists: such a `cd` lands in a folder only known when it runs (#614).
   */
  cdPath?: boolean;
  /**
   * True when the command sets `GIT_DIR` or `GIT_WORK_TREE`, which move the repository
   * `git rev-parse --show-toplevel` prints, or `PATH`, which may make `git` another program: a `cd`
   * there lands in a folder only known when it runs.
   */
  gitEnv?: boolean;
  /**
   * True when the command may change what `pwd`, `Get-Location` or `git` print: it defines a
   * function or an alias, or switches a builtin (`./current-folder`).
   */
  redefines?: boolean;
  /** The shell the command runs in, for how it names where it is (`./current-folder`). */
  shell?: ShellDialect;
  /** Extra writable roots (SessionOptions.additionalDirectories). */
  extraRoots?: readonly string[];
  /** The OS temp directories. Defaults to `osTempRoots()` for the running platform. */
  tempRoots?: readonly string[];
  /**
   * Folders outside the worktree where the agent keeps its own notes (Claude's plans and
   * auto-memory). Writable like temp, and like temp a secrets file there still asks.
   */
  notesRoots?: readonly string[];
  /** Defaults to `process.platform`; set in tests to exercise both path flavours. */
  platform?: NodeJS.Platform;
  /** Home directory used to expand `~`. Defaults to `process.env.HOME ?? USERPROFILE`. */
  home?: string;
  /**
   * Agent Rishi's data directory (`SessionOptions.agentRishiHome`): its credential files are guarded
   * (`./agent-rishi-home`), and `$AGENT_RISHI_HOME` resolves to it.
   */
  agentRishiHome?: string;
  /**
   * The session's own artifacts folder in Agent Rishi's home (`SessionOptions.artifactsDir`,
   * `<home>/artifacts/<session id>`): its screenshots and pasted images. A call that only reads
   * may read there freely (`./agent-rishi-home`'s `forReading`); writes and deletes there still ask.
   */
  artifactsDir?: string;
  /**
   * Set by `forReading` (`./agent-rishi-home`) on the context of a call that only reads: the session's
   * own artifacts folder then counts as one of its own folders in Agent Rishi's home.
   */
  reading?: boolean;
  /**
   * The agent's environment, for where the agent CLIs keep their logins (`CODEX_HOME`,
   * `CLAUDE_CONFIG_DIR`, `XDG_*`, ...; `./provider-logins`). Defaults to `process.env`.
   */
  env?: Readonly<Record<string, string | undefined>>;
}

/** A location saved on the shell's location stack: `PathContext`'s `dir` and `psDrive`. */
export interface SavedLocation {
  dir?: string;
  psDrive?: string;
  /** The named stack it is on (`Push-Location -StackName x`), lower-cased; none for the default. */
  stack?: string;
}

/** True when the context's paths are Windows paths. */
export const isWin = (ctx: PathContext) => (ctx.platform ?? process.platform) === "win32";

/** The path functions for the context's platform. */
export function pathApi(ctx: PathContext): path.PlatformPath {
  return isWin(ctx) ? path.win32 : path.posix;
}

/** The home directory `~` expands to. */
export function homeOf(ctx: PathContext): string {
  return ctx.home ?? process.env.HOME ?? process.env.USERPROFILE ?? "";
}

function tempRootsOf(ctx: PathContext): readonly string[] {
  return ctx.tempRoots ?? osTempRoots(ctx.platform);
}

/**
 * Home variables. Matched in any case: PowerShell's `$home` is the home directory too. PowerShell
 * also writes `$env:X` in braces, `${env:X}`.
 */
const HOME_VARS =
  /^(\$HOME|\$\{HOME\}|\$env:USERPROFILE|\$\{env:USERPROFILE\}|%USERPROFILE%)(?=$|[\\/])/i;
/**
 * Temp variables. Shell names are case-sensitive, so `$tmp` (a common name for what `mktemp`
 * printed) is not the temp directory; PowerShell's and cmd's names are not.
 */
const TEMP_VARS = [
  /^(\$TMPDIR|\$\{TMPDIR\}|\$TEMP|\$\{TEMP\}|\$TMP|\$\{TMP\})(?=$|[\\/])/,
  /^(\$env:TEMP|\$env:TMP|\$\{env:TEMP\}|\$\{env:TMP\}|%TEMP%|%TMP%)(?=$|[\\/])/i,
];
/**
 * Agent Rishi's home variable: case-sensitive in POSIX shells only. Agents don't inherit it
 * (`agentEnv`), but a shell profile or the command itself can set it, so it still resolves to
 * Agent Rishi's home.
 */
const AGENT_RISHI_HOME_VARS = [
  /^(\$AGENT_RISHI_HOME|\$\{AGENT_RISHI_HOME\})(?=$|[\\/])/,
  /^(\$env:AGENT_RISHI_HOME|\$\{env:AGENT_RISHI_HOME\}|%AGENT_RISHI_HOME%)(?=$|[\\/])/i,
];

/**
 * Git Bash paths on Windows: `/c/Users/x` is `C:\Users\x`, and `/tmp` is the user's temp
 * directory. WSL's mounts of the same drives (`/mnt/c/Users/x`, as `wsl` hands a Linux command
 * its paths) are read the same way.
 */
function fromGitBash(value: string, temp: string | undefined): string {
  if (temp && /^\/tmp(?=$|\/)/.test(value)) return temp + value.slice(4);
  const drive = /^(?:\/mnt)?\/([a-z])(?=$|\/)/i.exec(value);
  if (drive?.[1]) return `${drive[1].toUpperCase()}:\\${value.slice(drive[0].length + 1)}`;
  return value;
}

/**
 * `target` with its quotes taken off and `~`, the home, temp and Agent Rishi home variables and where
 * the shell is (`$(pwd)`, `$PWD`, `(Get-Location)`, `hereLength`) at its start expanded; on
 * Windows, a device path (`\\?\C:\x`) or a Git Bash path (`/c/x`, `/tmp/x`) as a Windows path.
 */
function expand(target: string, ctx: PathContext): string {
  let value = target.trim().replace(/^["']|["']$/g, "");
  if (isWin(ctx)) value = fromDevicePath(value);
  const here = hereLength(value, ctx);
  if (here > 0) value = (ctx.dir ?? ctx.cwd) + value.slice(here);
  const home = homeOf(ctx);
  if (value === "~" || value.startsWith("~/") || value.startsWith("~\\")) {
    value = home + value.slice(1);
  }
  value = value.replace(HOME_VARS, home);
  const agentRishi = ctx.agentRishiHome;
  if (agentRishi) for (const vars of AGENT_RISHI_HOME_VARS) value = value.replace(vars, agentRishi);
  const temp = tempRootsOf(ctx)[0];
  if (temp) for (const vars of TEMP_VARS) value = value.replace(vars, temp);
  return isWin(ctx) ? fromGitBash(value, temp) : value;
}

/**
 * `dir` after a `cd` to a folder that can't be known before the command runs (`cd $X`, `cd -`,
 * `cd "$(…)"`; `./locations`). No real path holds a NUL. Paths relative to it resolve below
 * `UNKNOWN_ROOT`, outside every root, and `..` never climbs out of it.
 */
export const UNKNOWN_DIR = "\0unknown";
const UNKNOWN_ROOT = { posix: "/\0unknown", win32: "\\\\\0unknown\\folder" };

/** True when `dir` is the folder of `UNKNOWN_DIR`. */
export const isUnknownDir = (dir: string | undefined): boolean => dir === UNKNOWN_DIR;

/**
 * How long the name of where the shell is that `value` (its quotes taken off) starts with is
 * (`./current-folder`: `$(pwd)/x`, `$PWD\x`, `(Get-Location)`), when that folder is known: not
 * after a `cd` to an unknown folder, nor on a PowerShell drive that isn't the filesystem. 0
 * otherwise.
 */
export function hereLength(value: string, ctx: PathContext): number {
  if (isUnknownDir(ctx.dir) || ctx.psDrive) return 0;
  return currentFolderLength(value, ctx);
}

/**
 * True when `value` (expanded) names the same place wherever the shell is: an absolute path, on
 * Windows with its drive (`\x` is on the current drive) or a UNC path.
 */
function rooted(value: string, ctx: PathContext): boolean {
  return isWin(ctx) ? /^(?:[a-z]:[\\/]|[\\/]{2})/i.test(value) : value.startsWith("/");
}

/**
 * True when a `cd` to `target` lands in a folder known before the command runs: no variable but
 * the home, temp and Agent Rishi home ones, no substitution (`$(…)`, backticks, PowerShell's `(…)`),
 * no cmd variable (`%X%`, `%~dp0`), brace expansion, wildcard (`.?` and `..*` can match `..`) or
 * `~user`, and not `cd -` (or PowerShell's `cd +`), which go back (or forward) in a history the
 * classifier doesn't see. From an unknown folder, only a rooted path is known; with `CDPATH` set
 * (`cdPath`), only a rooted one or one starting with `.` or `..`. Where the shell is
 * (`cd "$(pwd)/apps/web"`, `Set-Location (Get-Location)`) is known when `hereLength` says so.
 */
export function isKnownFolder(target: string, ctx: PathContext): boolean {
  const written = target.trim().replace(/^["']|["']$/g, "");
  const here = hereLength(written, ctx);
  const raw = here > 0 ? `.${written.slice(here)}` : written;
  if (/^[+-]\d*$/.test(raw) || /^~[^\\/]/.test(raw)) return false;
  if (/[*?[`]|^\(|\{[^}]*\}/.test(raw)) return false;
  const value = expand(target, ctx);
  if (/[$%]/.test(value)) return false;
  if (rooted(value, ctx)) return true;
  if (ctx.cdPath && !/^\.\.?(?:[\\/]|$)/.test(raw)) return false;
  return !isUnknownDir(ctx.dir);
}

/**
 * Resolve `target` (absolute, relative to `dir`, `~`-prefixed, or starting with a home, temp or
 * Agent Rishi home variable) to an absolute path. On Windows the directory it resolves from may be
 * in Git Bash form too: the shell reports `/c/Users/x/repo` once a command has run in it.
 */
export function resolveAgainst(target: string, ctx: PathContext): string {
  const p = pathApi(ctx);
  const value = expand(target, ctx);
  const base = ctx.dir ?? ctx.cwd;
  if (isUnknownDir(base) && !rooted(value, ctx)) {
    const parts = value.split(/[\\/]+/).filter((s) => s && s !== "." && s !== "..");
    return p.join(isWin(ctx) ? UNKNOWN_ROOT.win32 : UNKNOWN_ROOT.posix, ...parts);
  }
  return p.resolve(isWin(ctx) ? fromGitBash(base, tempRootsOf(ctx)[0]) : base, value);
}

/** True when `target` resolves inside `root` (or equals it). Case-insensitive on Windows. */
export function isInside(target: string, root: string, ctx: PathContext): boolean {
  const rel = relative(root, target, ctx);
  return rel === "" || (!climbsOut(rel) && !pathApi(ctx).isAbsolute(rel));
}

/**
 * True when a relative path leaves its folder: it starts with `..`, or with another name starting
 * with `..` (`..x`, which a variable may have been glued onto: `..$X`). A name of three or more dots
 * (Go's `./...`, a `'...'` in a one-liner) is a file or folder in it like any other (#663): on
 * Windows too, which reads it as a name, or trims a last one to the folder itself.
 */
function climbsOut(rel: string): boolean {
  const first = rel.split(/[\\/]/, 1)[0] ?? "";
  return first.startsWith("..") && !/^\.{3,}$/.test(first);
}

function relative(root: string, target: string, ctx: PathContext): string {
  const p = pathApi(ctx);
  const norm = (s: string) => (isWin(ctx) ? p.resolve(s).toLowerCase() : p.resolve(s));
  return p.relative(norm(root), norm(target));
}

/** True when two absolute paths name the same file. Case-insensitive on Windows. */
export function samePath(a: string, b: string, ctx: PathContext): boolean {
  return relative(a, b, ctx) === "";
}

/** A PowerShell provider path: its drive or provider, and the file path it stands for, if any. */
export interface ProviderPath {
  /** The drive (`hkcu`, `env`, `cert`) or provider (`registry`, `filesystem`), lower-cased. */
  drive: string;
  /** The filesystem path, for a `FileSystem::` path and the `Temp:` drive. */
  path?: string;
}

/** PowerShell drives (and providers) that only hold the running shell's own state. */
export const SHELL_DRIVES: ReadonlySet<string> = new Set([
  "env",
  "environment",
  "variable",
  "function",
  "alias",
]);

/**
 * A path that doesn't depend on the current location: a drive letter (`C:`), a UNC path, the
 * home directory (`~`) or a variable (`$env:TEMP\x`, `%TEMP%`).
 */
const ROOTED = /^(?:[a-z]:|[\\/]{2}|~|\$|%)/i;

/**
 * A PowerShell provider path on Windows, which Node's path functions would read as a relative
 * path: a drive named by more than one letter (`HKCU:\Software\Foo`, `Env:FOO`, `Cert:\`) or a
 * provider-qualified path (`Registry::HKEY_CURRENT_USER\…`,
 * `Microsoft.PowerShell.Core\FileSystem::C:\x`). After a `cd` onto such a drive (`ctx.psDrive`),
 * a relative path (`Foo`, `.`, `..\Bar`, `\Software`) is an item on that drive too. Undefined for
 * a file path, and elsewhere than Windows, where a colon is an ordinary character in a file name.
 */
export function providerPath(target: string, ctx: PathContext): ProviderPath | undefined {
  if (!isWin(ctx)) return undefined;
  const value = target.trim().replace(/^["']|["']$/g, "");
  const qualified = /^(?:[\w.]+\\)?([a-z]\w*)::(.*)$/is.exec(value);
  if (qualified) {
    const drive = (qualified[1] as string).toLowerCase();
    return drive === "filesystem" ? { drive, path: qualified[2] as string } : { drive };
  }
  const named = /^([a-z_]\w+):(.*)$/is.exec(value);
  if (!named) return ctx.psDrive && !ROOTED.test(value) ? { drive: ctx.psDrive } : undefined;
  const drive = (named[1] as string).toLowerCase();
  const temp = tempRootsOf(ctx)[0];
  if (drive !== "temp" || !temp) return { drive };
  // PowerShell's `Temp:` drive is the user's temp folder.
  return { drive, path: `${temp}\\${(named[2] as string).replace(/^[\\/]+/, "")}` };
}

/** True when `target` is inside the worktree or one of the extra roots. */
export function isInWorkspace(target: string, ctx: PathContext): boolean {
  const abs = resolveAgainst(target, ctx);
  return [ctx.cwd, ...(ctx.extraRoots ?? [])].some((root) => isInside(abs, root, ctx));
}

/** True when `target` is strictly inside one of the OS temp directories (never the root). */
export function isInTemp(target: string, ctx: PathContext): boolean {
  const abs = resolveAgainst(target, ctx);
  return tempRootsOf(ctx).some((root) => {
    const rel = relative(root, abs, ctx);
    return rel !== "" && isInside(abs, root, ctx);
  });
}

/** True when `target` is one of the OS temp directories itself. */
export function isTempRoot(target: string, ctx: PathContext): boolean {
  const abs = resolveAgainst(target, ctx);
  return tempRootsOf(ctx).some((root) => relative(root, abs, ctx) === "");
}

/** True when `target` is inside one of the agent's notes folders. */
export function isInNotes(target: string, ctx: PathContext): boolean {
  if (!ctx.notesRoots?.length) return false;
  const abs = resolveAgainst(target, ctx);
  return ctx.notesRoots.some((root) => isInside(abs, root, ctx));
}

/**
 * True when agents may write `target` without asking: the worktree, extra roots, temp or their
 * notes folders.
 */
export function isWritable(target: string, ctx: PathContext): boolean {
  return isInWorkspace(target, ctx) || isInTemp(target, ctx) || isInNotes(target, ctx);
}

/**
 * Usable temp roots from `candidates`: absolute, deduplicated, and never a filesystem root,
 * the home directory or one of its parents (a stray `TMPDIR=/` must not open everything).
 */
export function tempRootsFrom(
  candidates: ReadonlyArray<string | undefined>,
  platform: NodeJS.Platform,
  home: string,
): string[] {
  const ctx: PathContext = { cwd: "/", platform };
  const p = pathApi(ctx);
  const out: string[] = [];
  for (const candidate of candidates) {
    if (!candidate || !p.isAbsolute(candidate)) continue;
    const root = p.resolve(candidate);
    if (p.parse(root).root === root || p.dirname(root) === root) continue;
    if (home && isInside(home, root, ctx)) continue;
    if (!out.some((r) => relative(r, root, ctx) === "")) out.push(root);
  }
  return out;
}

const realpath = (p: string): string | undefined => {
  try {
    return realpathSync.native(p);
  } catch {
    return undefined;
  }
};

let cachedTempRoots: string[] | undefined;

/**
 * The OS temp directories for the running platform: `os.tmpdir()`, `%TEMP%` and `%TMP%` on
 * Windows, `$TMPDIR` and `/tmp` elsewhere, each also by its real path (macOS symlinks
 * `/tmp`, Windows may report a short 8.3 name). Empty when asked about another platform.
 */
export function osTempRoots(platform: NodeJS.Platform = process.platform): readonly string[] {
  if (platform !== process.platform) return [];
  if (cachedTempRoots) return cachedTempRoots;
  const env = process.env;
  const base = [
    os.tmpdir(),
    ...(platform === "win32" ? [env.TEMP, env.TMP] : [env.TMPDIR, "/tmp"]),
  ];
  const candidates = base.flatMap((c) => (c ? [c, realpath(c)] : []));
  cachedTempRoots = tempRootsFrom(candidates, platform, os.homedir());
  return cachedTempRoots;
}
