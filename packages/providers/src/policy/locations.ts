import { gitTopLevel } from "../util/git-head";
import { binName, CD, namedArg, unwrap } from "./command-words";
import { namesCurrentFolder } from "./current-folder";
import {
  isKnownFolder,
  isUnknownDir,
  isWin,
  type PathContext,
  providerPath,
  resolveAgainst,
  type SavedLocation,
  UNKNOWN_DIR,
} from "./paths";
import type { SimpleCommand } from "./shell";

/**
 * Where relative paths resolve as a command line runs (§11.2). `cd`, `Set-Location` and their kin
 * move the location. A `cd` onto a PowerShell drive that isn't the filesystem (`cd HKCU:\Software`,
 * then `cd Foo`) moves relative paths there (`psDrive`) until a `cd` back to a folder.
 *
 * `pushd` and `Push-Location` save the location they leave on a stack, and `popd` and
 * `Pop-Location` go back to the latest one saved (#541). With nothing saved earlier in the command,
 * the shell's own stack is unknown, so the location stays. Named stacks (`-StackName x`) are kept
 * apart. `Set-Location -StackName x` makes another stack the default, so it forgets the stack and
 * later pops stay where they are.
 *
 * Only a real pop goes back (#550). Plain `popd` and `Pop-Location` (also with `-PassThru`) pop in
 * every shell. Given anything else, shells disagree: bash refuses an unknown argument and stays,
 * `popd -n` stays too, dropping the entry it would go back to, and `popd +N` drops another one
 * (followed by forgetting the stack); PowerShell refuses a parameter it doesn't know and stays; cmd
 * ignores popd's arguments and pops. So such a pop is followed every way it may go, and so is
 * `dirs -c`, which empties bash's stack and is no command elsewhere. The risk classifier judges what
 * comes after in each of these locations (`locationsAfter`).
 */

const PUSH = new Set(["pushd", "push-location"]);
const POP = new Set(["popd", "pop-location"]);

/** The most locations a command line is followed in at once; past it, the command asks. */
export const MAX_LOCATIONS = 16;

/** Every location the shell may be in after `cmd`, from each of `ctxs`, without repeats. */
export function locationsAfter<T extends PathContext>(cmd: SimpleCommand, ctxs: readonly T[]): T[] {
  const seen = new Map<string, T>();
  for (const next of ctxs.flatMap((ctx) => afterCd(cmd, ctx))) {
    const key = JSON.stringify([next.dir, next.psDrive, next.pushed]);
    if (!seen.has(key)) seen.set(key, next);
  }
  return [...seen.values()];
}

/** The contexts after `cmd` when it changes location (`cd dir`, `Set-Location -Path dir`, `popd`). */
function afterCd<T extends PathContext>(cmd: SimpleCommand, ctx: T): T[] {
  const { tokens } = unwrap(cmd.words);
  const bin = binName(tokens[0]);
  if (bin === "dirs") {
    const clears = tokens.slice(1).some((a) => /^-[lpv]*c[clpv]*$/.test(a));
    return clears
      ? [ctx, { ...ctx, pushed: ctx.pushed?.filter((s) => s.stack !== undefined) }]
      : [ctx];
  }
  if (POP.has(bin)) return afterPop(bin, tokens.slice(1), ctx);
  if (tokens.length === 1 && isWin(ctx) && /^[a-z]:$/i.test(tokens[0] as string)) {
    return [toDrive(tokens[0] as string, ctx)];
  }
  if (!CD.has(bin)) return [ctx];
  const { stack, args } = withoutStackName(tokens.slice(1));
  const target = cdTarget(args);
  if (PUSH.has(bin)) {
    const saved: SavedLocation = { dir: ctx.dir, psDrive: ctx.psDrive, stack };
    // With no location, `Push-Location` saves the current one and stays.
    const moved = target === undefined ? ctx : moveTo(target, ctx);
    return [{ ...moved, pushed: [...(ctx.pushed ?? []), saved] }];
  }
  if (stack !== undefined) return [{ ...ctx, pushed: undefined }];
  return [moveTo(target ?? "~", ctx)];
}

/**
 * Where a pop may leave the shell: back to the latest location saved, or where it is. `popd` with
 * arguments may be any shell's, so it is followed both ways, and also with the entry bash's
 * `popd -n` drops or, for `popd +N`, with the stack forgotten.
 */
function afterPop<T extends PathContext>(bin: string, words: string[], ctx: T): T[] {
  const { stack, args } = withoutStackName(words);
  const back = popLocation(ctx, stack);
  // `-PassThru` (a prefix from `-Pa`, or bound, `-PassThru:$false`) only also writes the new
  // location out.
  const passThru = (a: string) => {
    const name = /^-(pa[a-z]*)(?::.*)?$/is.exec(a)?.[1];
    return name !== undefined && "passthru".startsWith(name.toLowerCase());
  };
  if (bin === "pop-location") return args.every(passThru) ? [back] : [ctx, back];
  if (words.length === 0) return [back];
  const out = [ctx, back, popLocation(ctx, undefined)];
  if (args.includes("-n")) out.push(dropLatest(ctx));
  if (args.some((a) => /^[+-]\d+$/.test(a))) out.push({ ...ctx, pushed: undefined });
  return out;
}

/**
 * The context with its location moved to `target`: a folder, an item on a PowerShell drive, or a
 * folder only known when the command runs (`cd $X`, `cd -`: `UNKNOWN_DIR`, #614). Where the shell
 * is (`cd "$(pwd)/apps/web"`, `./current-folder`) is a folder like any other; on a PowerShell
 * drive that isn't the filesystem (`Set-Location (Get-Location)` in `HKCU:`), the shell stays on it.
 */
export function moveTo<T extends PathContext>(given: string, ctx: T): T {
  if (ctx.psDrive && namesCurrentFolder(given.trim().replace(/^["']/, ""))) return ctx;
  const target = withTopLevel(given, ctx);
  const provider = providerPath(target, ctx);
  if (provider && provider.path === undefined) return { ...ctx, psDrive: provider.drive };
  const onDisk = { ...ctx, psDrive: undefined };
  const folder = provider?.path ?? target;
  if (!isKnownFolder(folder, onDisk)) return { ...onDisk, dir: UNKNOWN_DIR };
  return { ...onDisk, dir: resolveAgainst(folder, onDisk) };
}

/** `$(git rev-parse --show-toplevel)` (or in backticks) at the start of a word. */
const TOP_LEVEL =
  /^(["']?)(?:\$\(\s*git\s+rev-parse\s+--show-toplevel\s*\)|`\s*git\s+rev-parse\s+--show-toplevel\s*`)/;

/**
 * `target` with the repository's top folder in place of a `git rev-parse --show-toplevel` it
 * starts with (`cd "$(git rev-parse --show-toplevel)/apps/web"`), found on disk from where the
 * shell is (`gitTopLevel`). Left as it is (a folder only known when it runs) when the shell is
 * somewhere unknown, the command sets `GIT_DIR`, `GIT_WORK_TREE` or `PATH` (`gitEnv`) or may
 * redefine `git` (`redefines`: `git() { echo /other; }`), the paths are another platform's, or no
 * repository holds the folder.
 */
function withTopLevel(target: string, ctx: PathContext): string {
  const match = TOP_LEVEL.exec(target.trim());
  if (!match || ctx.gitEnv || ctx.redefines || isUnknownDir(ctx.dir) || ctx.psDrive) return target;
  if ((ctx.platform ?? process.platform) !== process.platform) return target;
  const top = gitTopLevel(resolveAgainst(".", ctx));
  return top === undefined ? target : `${match[1]}${top}${target.trim().slice(match[0].length)}`;
}

/**
 * PowerShell's `D:` (a function running `Set-Location D:`) and cmd's `D:`: to the folder the shell
 * last stood in on that drive, which may be any. The same drive changes nothing.
 */
function toDrive<T extends PathContext>(drive: string, ctx: T): T {
  const here = isUnknownDir(ctx.dir) ? undefined : resolveAgainst(".", ctx);
  const same = here?.toLowerCase().startsWith(drive.toLowerCase()) === true;
  return same && !ctx.psDrive ? ctx : { ...ctx, psDrive: undefined, dir: UNKNOWN_DIR };
}

/** Back to the latest location saved on `stack` (the default stack when undefined). */
function popLocation<T extends PathContext>(ctx: T, stack: string | undefined): T {
  const k = latest(ctx, stack);
  if (k < 0) return ctx;
  const saved = ctx.pushed?.[k] as SavedLocation;
  return { ...dropLatest(ctx, stack), dir: saved.dir, psDrive: saved.psDrive };
}

/** The context without the latest location saved on `stack`, staying where it is. */
function dropLatest<T extends PathContext>(ctx: T, stack?: string): T {
  const k = latest(ctx, stack);
  const pushed = ctx.pushed ?? [];
  return k < 0 ? ctx : { ...ctx, pushed: [...pushed.slice(0, k), ...pushed.slice(k + 1)] };
}

/** Where the latest location saved on `stack` is in `ctx.pushed`; -1 for none. */
function latest(ctx: PathContext, stack: string | undefined): number {
  const pushed = ctx.pushed ?? [];
  for (let k = pushed.length - 1; k >= 0; k -= 1) {
    if (pushed[k]?.stack === stack) return k;
  }
  return -1;
}

/**
 * The stack a `-StackName x` names (also a prefix, `-Stack x`, or bound, `-StackName:x`),
 * lower-cased, and the other words.
 */
function withoutStackName(args: string[]): { stack?: string; args: string[] } {
  const rest: string[] = [];
  let stack: string | undefined;
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i] as string;
    const param = /^-(s\w*)(?::(.*))?$/is.exec(arg);
    if (param && "stackname".startsWith((param[1] as string).toLowerCase())) {
      i += param[2] === undefined ? 1 : 0;
      stack = (param[2] ?? args[i] ?? "").toLowerCase();
    } else rest.push(arg);
  }
  return { stack, args: rest };
}

/** Bash's `cd` options (`-L`, `-P`, `-e`, `-@`), and the switches of `Set-Location` and its kin. */
const CD_FLAGS = /^-[LPe@]+$/;
const CD_SWITCHES = ["passthru", "verbose", "debug", "whatif", "confirm"];

/**
 * Where `cd`, `Set-Location` and their kin go, given their words without `-StackName`: `-Path x`,
 * or their one operand (cmd's `cd /d C:\dir` too, which also changes the drive; `/d` alone is Git
 * Bash's `D:\`). `-` (`./paths`' `isKnownFolder`) for a folder only known when it runs: `cd -`,
 * `pushd +1`, and two operands, as zsh's `cd old new` puts `new` for `old` in the current folder
 * (#614). A word after a parameter that isn't a switch (`-ErrorAction Stop`) is its value. None
 * for no folder.
 */
function cdTarget(args: string[]): string | undefined {
  // `pushd +1` and `pushd -1` rotate the stack, which may hold folders from earlier commands.
  if (args.some((a) => /^[+-]\d*$/.test(a))) return "-";
  const named = namedArg(args, ["-path", "-literalpath"]);
  if (named !== undefined) return named;
  const operands: string[] = [];
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i] as string;
    if (arg === "--") {
      operands.push(...args.slice(i + 1));
      break;
    }
    if (i === 0 && args.length > 1 && /^\/d$/i.test(arg)) continue;
    if (!arg.startsWith("-")) operands.push(arg);
    else if (!CD_FLAGS.test(arg) && !arg.includes(":")) {
      const name = arg.slice(1).toLowerCase();
      if (!CD_SWITCHES.some((s) => s.startsWith(name))) i += 1;
    }
  }
  return operands.length > 1 ? "-" : operands[0];
}
