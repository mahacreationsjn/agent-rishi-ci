import { binName, unwrap } from "./command-words";
import { type DeleteContext, listedPaths } from "./deletes";
import type { InlineScript } from "./inline-scripts";
import { readFd, readFind, xargsCommand } from "./search-runs";
import type { SimpleCommand } from "./shell";
import type { Feed } from "./stdin-scripts";

/**
 * Commands that a tool runs for the command line (§11.2), beside the shells' own inline scripts
 * (`./inline-scripts`): git (`rebase --exec`, `bisect run`, `submodule foreach`, an alias or
 * another setting given with `-c` that names a command), `awk`'s `system()` and pipes, `trap`,
 * `alias`, what `find -exec`, `fd -x`, `xargs` and GNU `parallel` run on what they are given, the
 * tool a package runner starts (`npx rimraf x`, `pnpm exec`, `uv run`, and a file tool a package
 * manager runs by name: `pnpm rimraf x`, `yarn run cpy a b`), what `dotenv` runs, and a PowerShell
 * script block made from a string. Each is judged like a command line of its own.
 */

/** More folders or piped paths than this are not each tried in a command run on them. */
const MAX_PLACES = 4;

/** A command given as words (`find -exec rm {} ;`), judged as it is. */
function ran(cmd: SimpleCommand, words: string[]): InlineScript {
  const command: SimpleCommand = { words, writes: [], nested: [], vars: cmd.vars };
  return { text: words.join(" "), dialect: "posix", commands: [command] };
}

/** A command line given as one string. `expands`: the shell filled in parts of it. */
const line = (text: string, expands = false): InlineScript => ({
  text,
  dialect: "posix",
  dynamic: expands,
});

const expands = (cmd: SimpleCommand, word: string): boolean =>
  cmd.vars?.has(word) === true || word.includes("`");

/** Git's global options that take the next word. */
const GIT_VALUED = new Set(["-C", "-c", "--git-dir", "--work-tree", "--namespace", "--exec-path"]);
/**
 * A setting given with `-c` whose value git runs: `alias.x=!cmd`, any `!cmd`, a pager or editor,
 * a filter, a merge or diff tool, a helper.
 */
const GIT_RUNS =
  /^(?:[\w.-]+=!|(?:core\.(?:pager|editor|sshcommand|fsmonitor|gitproxy|askpass)|sequence\.editor|diff\.external|pager\.[\w-]+|filter\.[\w.-]+\.(?:clean|smudge|process)|(?:merge|diff)tool\.[\w.-]+\.cmd|diff\.[\w.-]+\.(?:command|textconv)|merge\.[\w.-]+\.driver|credential\.(?:[^=]*\.)?helper|gpg\.(?:\w+\.)?program|uploadpack\.packobjectshook)=)(.+)$/is;
/** A variable set for one git command whose value git runs. */
const GIT_ENV =
  /^GIT_(?:EDITOR|SEQUENCE_EDITOR|PAGER|SSH_COMMAND|EXTERNAL_DIFF|ASKPASS|PROXY_COMMAND)=(.+)$/s;
/** Options whose value git runs as a command line, by subcommand. */
const GIT_EXEC: Record<string, RegExp> = {
  rebase: /^(?:-x|--exec)$/,
  difftool: /^(?:-x|--extcmd)$/,
  "filter-branch": /^--(?:tree|index|msg|env|commit|parent|tag-name)-filter$/,
};

function gitScripts(cmd: SimpleCommand, args: string[]): InlineScript[] {
  const out: InlineScript[] = [];
  for (const assign of unwrap(cmd.words).assigns) {
    const value = GIT_ENV.exec(assign)?.[1];
    if (value) out.push(line(value, expands(cmd, assign)));
  }
  let i = 0;
  for (; i < args.length && args[i]?.startsWith("-"); i += 1) {
    const option = args[i] as string;
    // `-c name=value`, or written together: `-cname=value`.
    const attached = /^-c(.+)$/s.exec(option)?.[1];
    if (!GIT_VALUED.has(option) && attached === undefined) continue;
    if (attached === undefined) i += 1;
    const setting = option.startsWith("-c") ? GIT_RUNS.exec(attached ?? args[i] ?? "") : null;
    if (setting) out.push(line(setting[1] as string, expands(cmd, args[i] as string)));
  }
  const sub = args[i]?.toLowerCase() ?? "";
  const rest = args.slice(i + 1);
  const exec = GIT_EXEC[sub];
  for (const [k, arg] of rest.entries()) {
    if (!exec) break;
    const [name = "", ...value] = arg.split("=");
    // `-x cmd`, `--exec=cmd`, and git's short forms `-ix cmd` and `-xcmd`.
    const short = sub === "rebase" ? /^-[a-wyz]*x(.*)$/s.exec(arg) : null;
    const given =
      exec.test(arg) || short?.[1] === ""
        ? rest[k + 1]
        : exec.test(name)
          ? value.join("=")
          : short?.[1];
    if (given) out.push(line(given, expands(cmd, given)));
  }
  if (sub === "bisect" && rest[0] === "run" && rest.length > 1) out.push(ran(cmd, rest.slice(1)));
  if (sub === "submodule" && rest.includes("foreach")) {
    const words = rest.slice(rest.indexOf("foreach") + 1).filter((a) => !a.startsWith("-"));
    if (words.length > 0)
      out.push(
        line(
          words.join(" "),
          words.some((w) => expands(cmd, w)),
        ),
      );
  }
  return out;
}

/** awk's `system("…")`, `print | "…"` and `"…" | getline`, with the command as one string. */
const AWK_RUNS = [
  /\bsystem\s*\(\s*"((?:[^"\\]|\\.)*)"\s*\)/g,
  /\|&?\s*"((?:[^"\\]|\\.)*)"/g,
  /"((?:[^"\\]|\\.)*)"\s*\|&?\s*getline\b/g,
];

function awkScripts(args: string[]): InlineScript[] {
  const out: InlineScript[] = [];
  for (const program of args) {
    let found = 0;
    for (const pattern of AWK_RUNS) {
      for (const match of program.matchAll(pattern)) {
        found += 1;
        out.push(line((match[1] as string).replace(/\\(["\\/])/g, "$1")));
      }
    }
    // A command built from the input (`system("rm " $1)`) is only known when it runs.
    const calls = program.match(/\bsystem\s*\(/g)?.length ?? 0;
    if (calls > found) out.push(line(/\bsystem\s*\(\s*"([^"]*)"/.exec(program)?.[1] ?? "", true));
  }
  return out;
}

/** What a search runs on what it finds, with each folder it searches in place of `{}`. */
function searchScripts(cmd: SimpleCommand, bin: string, args: string[]): InlineScript[] {
  const search = bin === "find" ? readFind(args) : readFd(args);
  const roots = (search.roots.length > 0 ? search.roots : ["."]).slice(0, MAX_PLACES);
  return search.runs.flatMap((run) => placed(cmd, run, roots, bin === "fd"));
}

/** `words` run on each of `places`: in place of `{}`, or (`append`) after them when it has none. */
function placed(
  cmd: SimpleCommand,
  words: string[],
  places: string[],
  append: boolean,
): InlineScript[] {
  if (words.length === 0) return [];
  if (!words.some((w) => w.includes("{}"))) {
    return [ran(cmd, append ? [...words, ...places] : words)];
  }
  // With nothing known to run it on, it is judged as written.
  return (places.length > 0 ? places : ["{}"]).map((place) =>
    ran(
      cmd,
      words.map((w) => w.split("{}").join(place)),
    ),
  );
}

/** Programs that run a tool from a package: every word after them, or after a subcommand. */
const RUNNERS: Record<string, readonly string[] | null> = {
  npx: null,
  pnpx: null,
  bunx: null,
  uvx: null,
  pnpm: ["exec", "dlx"],
  npm: ["exec", "x"],
  yarn: ["dlx", "exec"],
  bun: ["x"],
  uv: ["run"],
  pipx: ["run"],
  poetry: ["run"],
  pdm: ["run"],
};

/**
 * The tool a package runner starts, with its arguments: the words from the first that isn't an
 * option. An option's value may come first (`npx -p pkg tool`), so the next two words are tried
 * as the tool as well. `npx -c '…'` runs a command line.
 */
function runnerScripts(cmd: SimpleCommand, bin: string, args: string[]): InlineScript[] {
  if (!Object.hasOwn(RUNNERS, bin)) return [];
  const subs = RUNNERS[bin];
  const at = subs ? args.findIndex((a) => subs.includes(a)) : -1;
  if (subs && at < 0) return [];
  const rest = args.slice(at + 1);
  const out: InlineScript[] = [];
  const call = rest.findIndex((a) => a === "-c" || a === "--call");
  const called = call >= 0 && (bin === "npx" || bin === "npm") ? rest[call + 1] : undefined;
  if (called) out.push(line(called, expands(cmd, called)));
  let tried = 0;
  for (const [k, word] of rest.entries()) {
    if (word.startsWith("-") || tried >= 3) continue;
    tried += 1;
    // `npx rimraf@5 x` runs `rimraf`.
    out.push(ran(cmd, [word.replace(/(?<=.)@[^/]*$/, ""), ...rest.slice(k + 1)]));
  }
  return out;
}

/** Tools that delete or write the files they are given, which a package manager runs by name. */
const FILE_TOOLS = new Set(["rimraf", "del", "del-cli", "cpy", "cpx", "shx"]);
/**
 * Shells, interpreters and the tools that run a command with variables set, which a package
 * manager also runs by name (`pnpm node -e …`, `yarn sh -c …`, `pnpm cross-env A=1 rimraf x`).
 */
const RUNS_GIVEN =
  /^(?:sh|bash|zsh|dash|ksh|fish|pwsh|powershell|cmd|node|nodejs|deno|tsx|ts-node|perl|ruby|php|(?:python|pypy)[\d.]*|py|cross-env(?:-shell)?|dotenv)$/;

/**
 * Package managers that run a script, or else a package's tool, by name: bare (`pnpm rimraf x`,
 * `yarn rimraf x`, `bun rimraf x`) or with `run` (`npm run` only then), and their options that take
 * a value.
 */
const BY_NAME: Record<string, { bare: boolean; valued: readonly string[] }> = {
  pnpm: { bare: true, valued: ["--filter", "-F", "-C", "--dir", "--reporter"] },
  yarn: { bare: true, valued: ["--cwd"] },
  bun: { bare: true, valued: ["--cwd", "--filter", "-F"] },
  npm: { bare: false, valued: ["--prefix", "-w", "--workspace"] },
};

/**
 * The tool a package manager runs by name, with its arguments, when it is one that deletes or
 * writes files (`FILE_TOOLS`) or runs what it is handed (`RUNS_GIVEN`). Any other name
 * (`pnpm build`) runs a script of the project's manifest, or a command of the manager itself, so
 * it is left alone.
 */
function byName(cmd: SimpleCommand, bin: string, args: string[]): InlineScript[] {
  const spec = BY_NAME[bin];
  if (!spec) return [];
  let run = false;
  let i = 0;
  for (; i < args.length; i += 1) {
    const arg = args[i] as string;
    if (arg.startsWith("-")) {
      if (spec.valued.includes(arg)) i += 1;
    } else if (!run && (arg === "run" || arg === "run-script")) run = true;
    // `yarn workspace <name> <command>`.
    else if (!run && bin === "yarn" && arg === "workspace") i += 1;
    else break;
  }
  const tool = args[i]?.toLowerCase();
  if ((!run && !spec.bare) || tool === undefined) return [];
  if (!FILE_TOOLS.has(tool) && !RUNS_GIVEN.test(tool)) return [];
  return [ran(cmd, [tool, ...args.slice(i + 1)])];
}

/** dotenv's options that take a value: a file, a variable, a cascade, a variable to print. */
const DOTENV_VALUED = new Set(["-e", "-v", "-c", "-p", "-f", "--file"]);

/**
 * What `dotenv` runs with the variables of the files it reads: `dotenv -e .env -- cmd`
 * (dotenv-cli), `dotenv -f .env run cmd` (python-dotenv). Its own words stay with it, so the files
 * it reads still count as read.
 */
function dotenvScripts(cmd: SimpleCommand, args: string[]): InlineScript[] {
  let i = 0;
  for (let sub = false; i < args.length; i += 1) {
    const arg = args[i] as string;
    if (arg === "--") {
      i += 1;
      break;
    }
    if (!sub && arg === "run") sub = true;
    else if (!arg.startsWith("-")) break;
    else if (DOTENV_VALUED.has(arg)) i += 1;
  }
  return i < args.length ? [ran(cmd, args.slice(i))] : [];
}

/** GNU parallel's options that take the next word as their value. */
const PARALLEL_VALUED = new Set([
  ...["-j", "-P", "-S", "-a", "-d", "-E", "-I", "-C", "-n", "-N", "-L", "-l", "-s", "-J"],
  ...["--jobs", "--max-procs", "--sshlogin", "--arg-file", "--delimiter", "--eof", "--colsep"],
  ...["--joblog", "--results", "--res", "--tmpdir", "--workdir", "--wd", "--max-args"],
  ...["--max-lines", "--max-chars", "--timeout", "--delay", "--memfree", "--load", "--env"],
  ...["--basefile", "--bf", "--return", "--halt", "--retries", "--tagstring", "--block"],
  ...["--recstart", "--recend", "--ssh", "--sshdelay", "--limit", "--profile", "--filter"],
]);
/** The separators before parallel's arguments (`::: a b`) or the files that list them (`::::`). */
const PARALLEL_ARGS = /^::::?\+?$/;
/** Parallel's replacement strings: `{}`, `{.}`, `{/}`, `{//}`, `{/.}`, `{#}`, `{%}`, `{1}`. */
const REPLACEMENT = /\{[\d./#%]*\}/;

/**
 * What GNU parallel runs through a shell: its command (the words before the first `:::`), for
 * each argument given after `:::` or piped to it (`fed`), in place of its replacement strings or
 * after it. With no command, each argument is a command line. Arguments read from a file
 * (`::::`) or the terminal aren't known, so the command is judged as written.
 */
function parallelScripts(cmd: SimpleCommand, args: string[], fed: string[]): InlineScript[] {
  let i = 0;
  let mark: string | undefined;
  for (; i < args.length && args[i]?.startsWith("-"); i += 1) {
    if (args[i] === "-I") mark = args[i + 1];
    if (PARALLEL_VALUED.has(args[i] as string)) i += 1;
  }
  const end = args.findIndex((a, k) => k >= i && PARALLEL_ARGS.test(a));
  const words = args.slice(i, end < 0 ? args.length : end);
  const given: string[] = [];
  let listed = true;
  for (const arg of end < 0 ? [] : args.slice(end)) {
    if (PARALLEL_ARGS.test(arg)) listed = !arg.startsWith("::::");
    else if (listed) given.push(arg);
  }
  const places = (end < 0 ? fed : given).slice(0, MAX_PLACES);
  if (words.length === 0) return places.map((place) => line(place, expands(cmd, place)));
  const template = words.join(" ");
  const marked = REPLACEMENT.test(template) || (mark !== undefined && template.includes(mark));
  const all = new RegExp(REPLACEMENT.source, "g");
  return (places.length > 0 ? places : ["{}"]).map((place) => {
    const filled = template.replace(all, () => place);
    const text = marked ? (mark ? filled.split(mark).join(place) : filled) : `${template} ${place}`;
    return line(
      text,
      words.some((w) => expands(cmd, w)),
    );
  });
}

/** `[scriptblock]::Create(…)`, with the string it is given when that is written out. */
const SCRIPT_BLOCK = /\[scriptblock\]::Create\(\s*(?:'((?:[^']|'')*)'|"((?:[^"`]|`.)*)")?/gi;

function scriptBlocks(cmd: SimpleCommand): InlineScript[] {
  const out: InlineScript[] = [];
  for (const word of cmd.words) {
    for (const match of word.matchAll(SCRIPT_BLOCK)) {
      const text = match[1]?.replace(/''/g, "'") ?? match[2];
      const dynamic = text === undefined || (match[2] !== undefined && /[$`]/.test(text));
      out.push({ text: text ?? "", dialect: "powershell", dynamic });
    }
  }
  return out;
}

/**
 * The command lines the tool `bin` of `cmd` runs, given the words after it. `feed`: the pipe
 * `cmd` reads, whose paths `xargs` hands the command it runs.
 */
export function toolScripts(
  cmd: SimpleCommand,
  bin: string,
  args: string[],
  ctx: DeleteContext,
  feed: Feed,
): InlineScript[] {
  const blocks = scriptBlocks(cmd);
  if (bin === "git") return [...blocks, ...gitScripts(cmd, args)];
  if (/^[gmn]?awk$/.test(bin)) return [...blocks, ...awkScripts(args)];
  if (bin === "find" || bin === "fd") return [...blocks, ...searchScripts(cmd, bin, args)];
  if (bin === "xargs" || bin === "parallel") {
    const fed = feed.source ? listedPaths(feed.source, ctx).slice(0, MAX_PLACES) : [];
    if (bin === "parallel") return [...blocks, ...parallelScripts(cmd, args, fed)];
    return [...blocks, ...placed(cmd, xargsCommand(args), fed, true)];
  }
  if (bin === "dotenv") return [...blocks, ...dotenvScripts(cmd, args)];
  if (bin === "trap") {
    // `trap -l` and `trap -p` only list; `trap - EXIT` and `trap '' INT` run nothing.
    const [action, ...signals] = args[0] === "--" ? args.slice(1) : args;
    const runs = action && !/^-[lp]?$/.test(action) && signals.length > 0;
    return runs ? [...blocks, line(action, expands(cmd, action))] : blocks;
  }
  if (bin === "alias") {
    const bodies = args.flatMap((a) => /^[^=\s]+=(.+)$/s.exec(a)?.[1] ?? []);
    return [...blocks, ...bodies.map((body) => line(body))];
  }
  const runner = binName(bin);
  return [...blocks, ...runnerScripts(cmd, runner, args), ...byName(cmd, runner, args)];
}
