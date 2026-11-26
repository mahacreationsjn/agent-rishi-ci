import { isScriptBlock, joinScriptBlocks, namedArg, scriptBlockWords } from "./command-words";
import { isTempRoot, isWin, type PathContext } from "./paths";
import type { ShellDialect } from "./shell";

/**
 * Where a copy, move or file-writing command writes (§11.2): `cp`, `mv`, cmd's `copy`, `move`,
 * `xcopy` and `robocopy`, PowerShell's `Copy-Item` and `Move-Item`, the `cpy` and `cpx` packages,
 * and `tee`, `Set-Content`, `Out-File` and `Add-Content`.
 */

const COPIES = [
  ...["cp", "mv", "copy", "move", "copy-item", "move-item", "xcopy", "robocopy"],
  ...["cpy", "cpx"],
];
const WRITERS = ["tee", "set-content", "out-file", "add-content"];
/** The context of a copy: the paths, and the shell the command runs in when it is known. */
type CopyContext = PathContext & { shell?: ShellDialect };

/** cmd's own copies, and the switches each takes. */
const CMD_SWITCHES = new Map<string, RegExp>([
  ["copy", /^\/(?:-?y|[abdvnzl])$/i],
  ["move", /^\/-?y$/i],
]);
/** A switch of `xcopy` or `robocopy`: `/E`, `/R:3`. */
const TOOL_SWITCH = /^\/[a-z]+(:\S*)?$/i;

/**
 * True when `word` is a switch of the copy `bin`, not a path. `copy` and `move` are cmd's own
 * commands only where cmd may be the shell; in PowerShell they are `Copy-Item` and `Move-Item`,
 * and `/o` is a path. `xcopy` and `robocopy` are programs that read `/X` as a switch in any shell
 * but a POSIX one on Windows, which hands them `/c` as the `C:` drive. For `cp` and `mv`, `/tmp`
 * is a path.
 */
function isSwitch(bin: string, word: string, ctx: CopyContext): boolean {
  if (bin === "xcopy" || bin === "robocopy") return ctx.shell !== "posix" && TOOL_SWITCH.test(word);
  const cmd = isWin(ctx) && ctx.shell !== "posix" && ctx.shell !== "powershell";
  return cmd && CMD_SWITCHES.get(bin)?.test(word) === true;
}

/** What a copy or write writes: the paths to judge, and the words naming them that read nothing. */
export interface CopyWrites {
  targets: string[];
  words: string[];
}

/**
 * The destination of a copy, move or write. One a script block computes (`-Destination
 * { 'C:\Old\' + $_.Name }`) may be named by any of its words.
 */
export function copyWrites(bin: string, args: string[], ctx: CopyContext): CopyWrites {
  const dest = copyDestination(bin, args, ctx);
  if (dest === undefined) return { targets: [], words: [] };
  if (isScriptBlock(dest)) {
    const words = scriptBlockWords(dest).filter((w) => !w.startsWith("-"));
    return { targets: words, words };
  }
  return { targets: copyTargets(bin, args, dest, ctx), words: [dest] };
}

/** The path-like words of a copy or write: not options, nor cmd switches (`/E`, `/R:3`). */
function operands(bin: string, args: string[], ctx: CopyContext): string[] {
  return args.filter((a) => !a.startsWith("-") && !isSwitch(bin, a, ctx));
}

/** `cp -t DIR a b` and `mv --target-directory=DIR a b` name the destination first. */
function targetDirectory(bin: string, args: string[]): string | undefined {
  if (bin !== "cp" && bin !== "mv") return undefined;
  for (const [i, arg] of args.entries()) {
    if (arg === "--") return undefined;
    const long = /^--target-directory(?:=(.*))?$/s.exec(arg);
    if (long) return long[1] ?? args[i + 1];
    const short = /^-[a-su-zA-Z]*t(.*)$/s.exec(arg);
    if (short) return short[1] || args[i + 1];
  }
  return undefined;
}

/** Where a copy, move or file-writing command writes: a path, or a script block computing one. */
function copyDestination(bin: string, words: string[], ctx: CopyContext): string | undefined {
  if (!COPIES.includes(bin) && !WRITERS.includes(bin)) return undefined;
  const args = joinScriptBlocks(words);
  const named = WRITERS.includes(bin)
    ? namedArg(args, ["-path", "-filepath", "-literalpath"])
    : namedArg(args, ["-destination"]);
  if (named) return named;
  const directory = targetDirectory(bin, args);
  if (directory) return directory;
  const positional = operands(bin, args, ctx);
  return (WRITERS.includes(bin) ? positional[0] : positional.at(-1)) || undefined;
}

/**
 * The paths a copy or write lands on. A copy into a temp directory itself (`cp a.png /tmp/`)
 * writes the copied names inside it, so they are checked instead (a secrets file there asks).
 */
function copyTargets(bin: string, args: string[], dest: string, ctx: CopyContext): string[] {
  if (!COPIES.includes(bin) || !isTempRoot(dest, ctx)) return [dest];
  const sources = operands(bin, args, ctx).filter((a) => a !== dest);
  const names = sources
    .map(
      (s) =>
        s
          .replace(/[\\/]+$/, "")
          .split(/[\\/]/)
          .pop() ?? "",
    )
    .filter(Boolean);
  return names.length ? names.map((name) => `${dest.replace(/[\\/]+$/, "")}/${name}`) : [dest];
}
