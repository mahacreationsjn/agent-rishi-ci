/**
 * Files that tools write or change through their operands (§11.2), beside the copies, downloads
 * and item cmdlets the classifier already reads: `dd of=x`, `ln -s a x` (the link is what is
 * written), `install`, `rsync`, `unzip -d`, `chmod`, `chown` and `chgrp`, `sed -i`, `perl -pi`, `truncate`,
 * what a download, a sort or a patch saves (`curl -o x`, `wget -O x`, `sort -o x`, `patch -o x`),
 * the files a compressor replaces (`gzip x`), `mkfifo`, the database `sqlite3` opens, and git's
 * own outputs (`git clone url x`, `git worktree add x`, `git diff --output=x`,
 * `git format-patch -o x`, `git archive -o x`, `git config --file x`, `git submodule add url x`,
 * `git checkout-index --prefix=x`). The risk classifier judges each as a write.
 */
import { DISCARD } from "./command-words";
import { writesConfig } from "./git";

/** The value of `--name=value` or `--name value` (also a short form, `-o value`, `-ovalue`). */
function optionValues(args: string[], long: string, short?: string): string[] {
  const out: string[] = [];
  for (const [i, arg] of args.entries()) {
    const next = args[i + 1];
    if (arg === long || (short && arg === short)) {
      if (next !== undefined) out.push(next);
    } else if (arg.startsWith(`${long}=`)) out.push(arg.slice(long.length + 1));
    else if (short && arg.startsWith(short) && !arg.startsWith("--")) out.push(arg.slice(2));
  }
  return out.filter(Boolean);
}

/** The words that aren't options, and not the values of the options in `valued`. */
function operands(args: string[], valued: readonly string[] = []): string[] {
  const out: string[] = [];
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i] as string;
    if (arg === "--") return [...out, ...args.slice(i + 1)];
    if (valued.includes(arg)) i += 1;
    else if (!arg.startsWith("-") || arg === "-") out.push(arg);
  }
  return out;
}

/** True when `sed`'s words hold `-i` (`-i.bak`, a cluster such as `-ni`, `--in-place`). */
const editsInPlace = (args: string[]): boolean =>
  args.some((a) => /^--in-place(=|$)/.test(a) || /^-[a-zA-Z]*i/.test(a));

/** The files `bin` writes or changes through its operands; none for other programs. */
export function toolWrites(bin: string, args: string[]): string[] {
  if (bin === "dd") {
    return args.filter((a) => /^of=./i.test(a)).map((a) => a.slice(3));
  }
  if (bin === "ln") {
    // `-t dir`, also at the end of a cluster (`-st dir`).
    const clustered = args.filter((_, i) => /^-[a-zA-Z]+t$/.test(args[i - 1] ?? ""));
    const into = [...optionValues(args, "--target-directory", "-t"), ...clustered];
    const names = operands(args, ["-t", "--target-directory", "-S", "--suffix"]);
    // One name links it into the current folder; with more, the last is the link or its folder.
    return [...into, ...(names.length > 1 ? names.slice(-1) : [])];
  }
  if (bin === "chmod" || bin === "chown" || bin === "chgrp") {
    // The first operand is the mode or the owner, unless `--reference` gives it, or the mode
    // reads as an option (`chmod -w x`).
    const given = args.some(
      (a) => a.startsWith("--reference") || (bin === "chmod" && /^-[rwxXst]+$/.test(a)),
    );
    return operands(args, ["--reference"]).slice(given ? 0 : 1);
  }
  if (bin === "install" || bin === "rsync") {
    const into = optionValues(args, "--target-directory", bin === "install" ? "-t" : undefined);
    const names = operands(args, ["-t", "-m", "-o", "-g", "-e", "--mode", "--owner", "--group"]);
    // Not another machine's folder (`rsync . host:dir`).
    const local = (name: string) => !/^[^/\\]+:/.test(name);
    return [...into, ...(names.length > 1 ? names.slice(-1) : [])].filter(local);
  }
  if (bin === "unzip")
    return args.flatMap((a, i) => (a === "-d" && args[i + 1] ? [args[i + 1] as string] : []));
  if (bin === "truncate") return operands(args, ["-s", "--size", "-r", "--reference"]);
  if (bin === "sed" && editsInPlace(args)) {
    // Letters after an `i` are its backup suffix (`-ie`), not `-e`.
    const scripted = args.some((a) => /^(-[a-hj-zA-Z]*[ef]|--expression|--file)/.test(a));
    const valued = ["-e", "-f", "--expression", "--file", "-l", "--line-length"];
    return operands(args, valued).slice(scripted ? 0 : 1);
  }
  if ((bin === "perl" || bin === "ruby") && args.some((a) => IN_PLACE.test(a))) {
    return editedInPlace(args);
  }
  // `curl -o /dev/null` and `wget -O -` save nothing.
  return moreToolWrites(bin, args).filter((target) => target !== "-" && !DISCARD.test(target));
}

/** The values of short options (`-o x`, `-ox`, at the end of a cluster: `-sSLo x`). */
function shortValues(args: string[], letters: string): string[] {
  const out: string[] = [];
  for (const [i, arg] of args.entries()) {
    const at = /^-[a-zA-Z#]+/.test(arg)
      ? [...arg].findIndex((c, k) => k > 0 && letters.includes(c))
      : -1;
    if (at < 0) continue;
    const value = arg.slice(at + 1) || args[i + 1];
    if (value !== undefined) out.push(value);
  }
  return out;
}

/** Compressors, which replace each file they are given unless they write to the output. */
const COMPRESSORS = /^(?:gzip|gunzip|xz|unxz|bzip2|bunzip2|zstd|unzstd|lz4|compress|uncompress)$/;

/** `sqlite3`'s options that take the next word. */
const SQLITE_VALUED = ["-cmd", "-init", "-separator", "-newline", "-nullvalue", "-vfs", "-maxsize"];

/** Downloads, sorters, patches, compressors, pipes and databases: the files they write. */
function moreToolWrites(bin: string, args: string[]): string[] {
  if (bin === "curl") {
    return [
      ...shortValues(args, "oDc"),
      ...[
        "--output",
        "--output-dir",
        "--dump-header",
        "--cookie-jar",
        "--trace",
        "--stderr",
      ].flatMap((long) => optionValues(args, long)),
    ];
  }
  if (bin === "wget") {
    const longs = ["--output-document", "--directory-prefix", "--output-file", "--append-output"];
    return [...shortValues(args, "OPoa"), ...longs.flatMap((long) => optionValues(args, long))];
  }
  if (bin === "sort") return optionValues(args, "--output", "-o");
  if (bin === "patch") {
    const longs = ["--output", "--directory", "--reject-file"];
    return [...shortValues(args, "odr"), ...longs.flatMap((long) => optionValues(args, long))];
  }
  if (COMPRESSORS.test(bin)) {
    // `-c`, `-t` and `-l` (also in a cluster, `-dc`) write no file.
    const reads = args.some(
      (a) => /^-[a-zA-Z0-9]*[ctl]/.test(a) || /^--(stdout|test|list)$/.test(a),
    );
    const out = bin === "zstd" || bin === "lz4" ? optionValues(args, "--output", "-o") : [];
    return reads ? out : [...out, ...operands(args, ["-S", "--suffix", "-T", "-M", "-o"])];
  }
  if (bin === "mkfifo" || bin === "mknod") {
    const names = operands(args, ["-m", "--mode", "-Z", "--context"]);
    return bin === "mknod" ? names.slice(0, 1) : names;
  }
  if (bin === "sqlite3" && !args.some((a) => /^--?readonly$/.test(a))) {
    // The database is its first operand; `:memory:` and none are no file.
    return operands(args, SQLITE_VALUED)
      .slice(0, 1)
      .filter((db) => db && !db.startsWith(":"));
  }
  return [];
}

/** `perl -pi -e …` and `ruby -i -pe …`: `-i`, alone, in a cluster or with a backup suffix. */
const IN_PLACE = /^-[lnpaws0]*i/;

/** The files an in-place `perl` or `ruby` edits: its operands, after the script when no `-e` gives it. */
function editedInPlace(args: string[]): string[] {
  const out: string[] = [];
  let scripted = false;
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i] as string;
    if (arg === "--") {
      out.push(...args.slice(i + 1));
      break;
    }
    if (IN_PLACE.test(arg)) continue;
    if (/^-[a-zA-Z0-9]*[eE]$/.test(arg)) {
      scripted = true;
      i += 1;
    } else if (!arg.startsWith("-")) out.push(arg);
  }
  return scripted ? out : out.slice(1);
}

/** Git's global options that take the next word (`-C dir`, `-c name=value`). */
const GIT_VALUED = new Set(["-C", "-c", "--git-dir", "--work-tree", "--namespace", "--exec-path"]);
/** Options of `git clone` and `git worktree add` that take the next word. */
const CLONE_VALUED = ["-b", "--branch", "-o", "--origin", "--depth", "-c", "--config", "-j"];
const CLONE_MORE = ["--reference", "--separate-git-dir", "--template", "-u", "--upload-pack"];
const WORKTREE_VALUED = ["-b", "-B", "--reason", "--orphan"];
const SUBMODULE_VALUED = ["-b", "--branch", "--name", "--reference", "--depth"];

/** The files and folders a git command writes outside its repository's own state. */
export function gitWrites(args: string[]): string[] {
  let i = 0;
  while (i < args.length && args[i]?.startsWith("-"))
    i += GIT_VALUED.has(args[i] as string) ? 2 : 1;
  const sub = args[i]?.toLowerCase();
  const rest = args.slice(i + 1);
  if (sub === "clone") {
    const names = operands(rest, [...CLONE_VALUED, ...CLONE_MORE]);
    return [...names.slice(1, 2), ...optionValues(rest, "--separate-git-dir")];
  }
  if (sub === "init") return operands(rest, ["-b", "--initial-branch", "--template"]).slice(0, 1);
  if (sub === "worktree" && rest[0]?.toLowerCase() === "add") {
    return operands(rest.slice(1), WORKTREE_VALUED).slice(0, 1);
  }
  if (sub === "format-patch") return optionValues(rest, "--output-directory", "-o");
  if (sub === "archive" || sub === "bundle") {
    const out = optionValues(rest, "--output", sub === "archive" ? "-o" : undefined);
    return sub === "bundle" && rest[0] === "create" ? [...out, ...rest.slice(1, 2)] : out;
  }
  // `git config --file x name value` changes that file; reading it writes nothing.
  if (sub === "config") {
    const changes = writesConfig(rest.map((a) => a.toLowerCase()));
    return changes ? optionValues(rest, "--file", "-f") : [];
  }
  if (sub === "submodule" && rest[0]?.toLowerCase() === "add") {
    // `git submodule add <url> <path>`: without a path it lands in the current folder.
    return operands(rest.slice(1), SUBMODULE_VALUED).slice(1, 2);
  }
  if (sub === "checkout-index") return optionValues(rest, "--prefix");
  // `git diff`, `git log`, `git show` and their kin write their output to `--output=file`.
  return optionValues(rest, "--output");
}
