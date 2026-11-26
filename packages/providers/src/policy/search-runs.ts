/**
 * Reading the commands that run another command on a list of files (§11.2): `find … -exec`,
 * `fd -x` and `xargs`. `./deletes` judges the deletes among them, `./tool-scripts` everything else
 * they run.
 */

/** `xargs` options that take the next word as their value. */
const XARGS_VALUED = new Set([
  "-a",
  "-d",
  "-E",
  "-I",
  "-L",
  "-n",
  "-P",
  "-s",
  "--arg-file",
  "--delimiter",
  "--max-args",
  "--max-chars",
  "--max-procs",
  "--process-slot-var",
]);

/** `find`'s actions that run a command on what it finds. */
const FIND_RUNS = new Set(["-exec", "-execdir", "-ok", "-okdir"]);
/** `fd`'s options that run a command on what it finds: the words after them, up to `;`. */
const FD_RUNS = new Set(["--exec", "--exec-batch"]);
/** `fd`'s options whose value is a folder it searches. */
const FD_ROOTS = new Set(["--search-path", "--base-directory"]);
/** `fd`'s other long options that take the next word as their value. */
const FD_VALUED = new Set([
  "--extension",
  "--type",
  "--max-depth",
  "--maxdepth",
  "--min-depth",
  "--exact-depth",
  "--exclude",
  "--threads",
  "--color",
  "--size",
  "--changed-within",
  "--changed-before",
  "--change-newer-than",
  "--change-older-than",
  "--newer",
  "--older",
  "--owner",
  "--ignore-file",
  "--max-results",
  "--path-separator",
  "--batch-size",
  "--format",
  "--and",
  "--max-buffer-time",
]);
/** `fd`'s short options that take a value (`-e log`, `-elog`). */
const FD_VALUED_SHORT = "deEtjcSo";

/** What a search reads: the folders it searches, the commands it runs, whether it deletes. */
export interface Search {
  roots: string[];
  runs: string[][];
  deletes: boolean;
}

/** `find path… expression`: its paths, its `-exec` style commands and its `-delete`. */
export function readFind(args: string[]): Search {
  const runs: string[][] = [];
  let deletes = false;
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i] as string;
    if (arg === "-delete") deletes = true;
    else if (FIND_RUNS.has(arg)) {
      const end = runEnd(args, i + 1);
      runs.push(args.slice(i + 1, end));
      i = end;
    }
  }
  return { roots: findPaths(args), runs, deletes };
}

/**
 * `fd [options] [pattern] [path…]`: the paths (and `--search-path`, `--base-directory`), and the
 * commands of `-x`/`--exec` and `-X`/`--exec-batch`, which take every word after them up to `;`.
 */
export function readFd(args: string[]): Search {
  const positional: string[] = [];
  const roots: string[] = [];
  const runs: string[][] = [];
  const run = (first: string, from: number): number => {
    const end = runEnd(args, from);
    runs.push([...(first ? [first] : []), ...args.slice(from, end)]);
    return end;
  };
  let options = true;
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i] as string;
    if (!options || !arg.startsWith("-") || arg === "-") {
      positional.push(arg);
    } else if (arg === "--") {
      options = false;
    } else if (arg.startsWith("--")) {
      const [name = "", ...value] = arg.split("=");
      const bound = value.length > 0 ? value.join("=") : undefined;
      if (FD_RUNS.has(name)) i = run(bound ?? "", i + 1);
      else if (FD_ROOTS.has(name)) roots.push(bound ?? (args[++i] as string));
      else if (FD_VALUED.has(name) && bound === undefined) i += 1;
    } else {
      // Short options, bundled or not (`-HIx rm`, `-elog`): `-x`/`-X` run the rest of the word
      // and the words after it; a valued one takes the rest of the word or the next word.
      for (let c = 1; c < arg.length; c += 1) {
        const ch = arg[c] as string;
        if (ch === "x" || ch === "X") {
          i = run(arg.slice(c + 1), i + 1);
          break;
        }
        if (FD_VALUED_SHORT.includes(ch)) {
          if (c === arg.length - 1) i += 1;
          break;
        }
      }
    }
  }
  return { roots: [...roots, ...positional.slice(1)].filter(Boolean), runs, deletes: false };
}

/**
 * Where a command run by `find -exec` or `fd -x` ends: at a `;` word, or (`find`'s batch form)
 * a `+` right after `{}`. The index of the terminator, or the end of the words.
 */
function runEnd(args: string[], from: number): number {
  for (let k = from; k < args.length; k += 1) {
    const word = args[k] as string;
    if (word === ";" || word === "\\;" || (word === "+" && args[k - 1] === "{}")) return k;
  }
  return args.length;
}

/** The command `xargs` runs: the words after its options. */
export function xargsCommand(args: string[]): string[] {
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i] as string;
    if (arg === "--") return args.slice(i + 1);
    if (!arg.startsWith("-")) return args.slice(i);
    if (XARGS_VALUED.has(arg)) i += 1;
  }
  return [];
}

/** `find [-H|-L|-P] [-D x] [-O1] path… expression`: the paths. */
export function findPaths(args: string[]): string[] {
  let k = 0;
  while (k < args.length && /^-([HLP]|D|O\d*)$/.test(args[k] as string)) {
    k += args[k] === "-D" ? 2 : 1;
  }
  const rest = args.slice(k);
  const end = rest.findIndex((a) => /^[-(!)]/.test(a));
  return end < 0 ? rest : rest.slice(0, end);
}
