import { mostSevere, type RiskAssessment } from "./assessment";
import { binName, CD, unwrap } from "./command-words";
import { moveTo } from "./locations";
import { isUnknownDir, type PathContext, pathApi } from "./paths";
import { programDenial } from "./read-only";
import { matchesLong } from "./read-only-options";
import { findPaths } from "./search-runs";
import type { SimpleCommand } from "./shell";
import { runsInRisk } from "./workdir";

/**
 * Where a command runs (§11.2, #614). A command that changes something without naming a path
 * (`git reset --hard`, `make clean`, `npm install`) changes the folder it runs in: where a `cd`,
 * `pushd` or `Set-Location` earlier in the command line moved (`./locations`), or the folder a
 * program's own option names (`git -C dir`, `make -C dir`, `npm --prefix dir`, `env -C dir`, ...).
 * Each folder is judged by `./workdir`'s `runsInRisk`, the rule for the folder a provider reports
 * too: outside the session's writable roots (the worktree, extra roots, temp and notes folders),
 * anything but a read (`programDenial`, the read-only rules) asks as a write there; in Agent Rishi's
 * own home, outside the session's own folders, it asks at every level. A folder only known when
 * the command runs (`cd $X`, `git -C` given its folder by `xargs`) counts as outside.
 */

/** A program's options that name the folder it works in. */
interface FolderOptions {
  /** Short options naming a folder it moves to, relative to the last (`-C dir`, `-Cdir`, `-sC dir`). */
  short?: string;
  /** Short options that take a value, so the rest of their word (or the next word) is no option. */
  valued?: string;
  /** Long options naming a folder it moves to (`--directory dir`, `--directory=dir`, `--dir`). */
  long?: readonly string[];
  /** Long options naming another folder it changes (`git --git-dir`, `--work-tree`). */
  also?: readonly string[];
  /** Still works in the folder it was started in too (`tar -C` only moves what it extracts). */
  keepsBase?: true;
}

const MAKE: FolderOptions = { short: "C", valued: "fIoW", long: ["--directory"] };

const FOLDER_OPTIONS = new Map<string, FolderOptions>([
  ["git", { short: "C", valued: "c", also: ["--git-dir", "--work-tree"] }],
  ["make", MAKE],
  ["gmake", MAKE],
  ["npm", { short: "C", long: ["--prefix"] }],
  ["npx", { long: ["--prefix"] }],
  ["pnpm", { short: "C", long: ["--dir"] }],
  ["yarn", { long: ["--cwd"] }],
  ["bun", { long: ["--cwd"] }],
  ["go", { short: "C" }],
  ["ninja", { short: "C", valued: "fjklt" }],
  ["tar", { short: "C", valued: "fbFgHIKLNTVX", long: ["--directory"], keepsBase: true }],
]);

/** The variables that move git elsewhere (`GIT_DIR=../x/.git git reset --hard`). */
const GIT_FOLDER_VARS = /^(GIT_DIR|GIT_WORK_TREE)=(.*)$/s;
/** git's setting that moves its work tree (`git -c core.worktree=../x reset --hard`). */
const GIT_WORKTREE_SETTING = /^core\.worktree=(.*)$/is;

/**
 * A folder option given no folder: `xargs git -C` takes it from its input, so it is only known
 * when the command runs (`./paths`' `isKnownFolder`).
 */
const FROM_INPUT = "-";

/** `find`'s actions that run a command in the folder of each file found (`-execdir make \;`). */
const FIND_IN_FOLDER = new Set(["-execdir", "-okdir"]);

/** Navigation reads and writes nothing where it starts: only where it lands counts. */
const NAVIGATION = new Set([...CD, "popd", "pop-location", "dirs"]);

/** A folder option's value, by kind: a folder it moves to, or another folder it changes. */
interface FolderWord {
  word: string;
  moves: boolean;
}

/** The folder words in the arguments of a program with folder options (up to `--`). */
function folderWords(bin: string, args: readonly string[], options: FolderOptions): FolderWord[] {
  const out: FolderWord[] = [];
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i] as string;
    if (arg === "--") break;
    if (arg.startsWith("--")) {
      const [name = "", ...rest] = arg.split("=");
      const long = options.long?.some((o) => matchesLong(name, o));
      const also = options.also?.some((o) => matchesLong(name, o));
      if (!long && !also) continue;
      const word = rest.length > 0 ? rest.join("=") : args[++i];
      out.push({ word: word ?? FROM_INPUT, moves: long === true });
    } else if (/^-[^-]/.test(arg)) {
      // A cluster of short options (`-sC dir`): the first that takes a value ends it.
      for (let k = 1; k < arg.length; k += 1) {
        const c = arg[k] as string;
        const folder = options.short?.includes(c) === true;
        if (!folder && !options.valued?.includes(c)) continue;
        const word = arg.slice(k + 1) || args[++i];
        if (folder) out.push({ word: word ?? FROM_INPUT, moves: true });
        const setting = bin === "git" && c === "c" ? GIT_WORKTREE_SETTING.exec(word ?? "") : null;
        if (setting) out.push({ word: setting[1] as string, moves: false });
        break;
      }
    }
  }
  return out;
}

/**
 * The folders `find … -execdir cmd` (or `-okdir`) runs its command in: the one holding each path
 * it searches (`find /x/y` runs it in `/x` for `/x/y` itself), and the folders below it. `.` runs
 * it in `.`. None for a `find` that runs nothing so.
 */
function findFolders(args: readonly string[], base: PathContext): string[] {
  if (!args.some((a) => FIND_IN_FOLDER.has(a))) return [];
  const roots = findPaths([...args]);
  return (roots.length > 0 ? roots : ["."]).map((root) => {
    const at = moveTo(root, base);
    const dir = at.dir ?? at.cwd;
    if (isUnknownDir(dir) || /^\.[\\/]*$/.test(root)) return dir;
    return pathApi(base).dirname(dir);
  });
}

/**
 * The folders `cmd` runs or changes things in, as absolute paths (or `UNKNOWN_DIR`): where the
 * shell is, after `env -C`, then each folder its own options name. Every program in its words is
 * read, so a wrapper (`timeout 60 git -C …`, `xargs make -C …`) can't hide one.
 */
export function runFolders(cmd: SimpleCommand, ctx: PathContext): string[] {
  const { tokens, chdir, assigns } = unwrap(cmd.words);
  let base = ctx;
  for (const dir of chdir) base = moveTo(dir, base);
  const at = (c: PathContext) => c.dir ?? c.cwd;
  const out: string[] = [];
  let moved = false;
  for (const [k, token] of tokens.entries()) {
    const bin = binName(token);
    if (bin === "find") out.push(...findFolders(tokens.slice(k + 1), base));
    const options = FOLDER_OPTIONS.get(bin);
    if (!options) continue;
    let here = base;
    for (const { word, moves } of folderWords(bin, tokens.slice(k + 1), options)) {
      if (moves) here = moveTo(word, here);
      out.push(at(moves ? here : moveTo(word, here)));
    }
    moved ||= here !== base && !options.keepsBase;
  }
  for (const assign of assigns) {
    const git = GIT_FOLDER_VARS.exec(assign);
    if (git) out.push(at(moveTo(git[2] as string, base)));
  }
  return moved ? out : [at(base), ...out];
}

/**
 * The risk of `cmd` running where it runs (`runFolders`), by `runsInRisk`: undefined when every
 * folder it works in is the session's own, or it only reads outside Agent Rishi's home. Of several
 * folders, Agent Rishi's home wins over the rest (`mostSevere`).
 */
export function folderRisk(cmd: SimpleCommand, ctx: PathContext): RiskAssessment | undefined {
  const { tokens } = unwrap(cmd.words);
  // Only assignments (`X=1`, PowerShell's `$x = 'a'` after `./ps-assignments`): nothing runs.
  if (tokens.length === 0) return undefined;
  const bin = binName(tokens[0]);
  if (NAVIGATION.has(bin)) return undefined;
  const reads = programDenial(bin, tokens.slice(1)) === undefined;
  const risks = runFolders(cmd, ctx).flatMap((dir) => runsInRisk(dir, reads, ctx) ?? []);
  return risks.length > 0 ? mostSevere(risks) : undefined;
}

/** `folderRisk` when every level asks about it: a command run in Agent Rishi's own home. */
export function agentRishiFolderRisk(
  cmd: SimpleCommand,
  ctx: PathContext,
): RiskAssessment | undefined {
  const risk = folderRisk(cmd, ctx);
  return risk?.risky && risk.agentRishi ? risk : undefined;
}
