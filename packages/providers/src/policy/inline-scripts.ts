import { binName } from "./command-words";
import type { ShellDialect, SimpleCommand } from "./shell";
import type { Scope } from "./shell-builder";
import { type StartedProcess, startedProcesses } from "./start-process";
import { holdsSubstitution, holdsVariable } from "./variables";

/**
 * Command lines that another command runs (§11.2): a shell's inline script (`bash -c "…"`,
 * `pwsh -Command …`, `cmd /c …`), the commands of cmd's `for` loop (#499) and the program
 * `Start-Process` starts (#541, `./start-process`), with the script of a shell it starts (#550),
 * and the string `eval`, `Invoke-Expression` or `iex` runs. The risk classifier parses each one
 * and classifies it like a command line of its own.
 */

export interface InlineScript {
  /** The command line, as the shell gets it. */
  text: string;
  dialect: ShellDialect;
  /**
   * True when its output goes to the command that runs it rather than to the agent, like the
   * command a `for /f` loop reads (`('set AWS')`).
   */
  feeds?: boolean;
  /** The folder it runs in (`Start-Process -WorkingDirectory`), as written; else where it is run. */
  dir?: string;
  /** True when it runs elevated (`Start-Process -Verb RunAs`). */
  elevated?: boolean;
  /**
   * True when it isn't all written out: `eval "$CMD"`, `iex $x`, `iex (Get-Content x)`, or what a
   * pipe hands `iex`. What runs is only known when it runs, so it asks unless what is written
   * only reads.
   */
  dynamic?: boolean;
  /** The variables set where it runs, when it runs in the shell that set them (`./variables`). */
  scope?: Scope;
  /**
   * The commands it runs, when they are given as words and not as one line (`find -exec rm {} ;`,
   * `npx rimraf x`): judged as they are, and `text` is not read.
   */
  commands?: SimpleCommand[];
}

const SHELLS = new Set(["sh", "bash", "zsh", "dash", "ksh", "ash", "fish"]);

const EVALS = new Set(["iex", "invoke-expression"]);
/** Text a shell fills in when it runs: a variable or a substitution. */
const EXPANDS = /[$`]/;

/**
 * The command lines `bin` runs, given the words after it; `cmd`: the command they are from, and
 * `source`: the command at the head of the pipeline it reads, if any.
 */
export function inlineScripts(
  bin: string,
  args: string[],
  cmd: SimpleCommand,
  source?: SimpleCommand,
): InlineScript[] {
  if (bin === "eval") {
    const text = args.join(" ");
    const dynamic = EXPANDS.test(text) || cmd.nested.length > 0;
    return text.trim() ? [{ text, dialect: "posix", dynamic }] : [];
  }
  if (EVALS.has(bin)) return evaluated(args, cmd, source);
  const flag = scriptFlag(bin, args);
  if (SHELLS.has(bin)) {
    const text = flag >= 0 ? args.slice(flag + 1).find((a) => !a.startsWith("-")) : undefined;
    // A script the outer shell builds (`sh -c "$(…)"`, `sh -c "$CMD"`) is only known when it runs.
    const dynamic = text !== undefined && cmd.vars?.has(text) === true && built(text);
    return text ? [{ text, dialect: "posix", dynamic }] : [];
  }
  if (bin === "pwsh" || bin === "powershell") {
    if (flag < 0) return positional(bin, args);
    const bound = /^[^:]+:(.+)$/s.exec(args[flag] as string)?.[1];
    const rest = bound === undefined ? args.slice(flag + 1) : [bound, ...args.slice(flag + 1)];
    if (ENCODED.test(args[flag] as string)) return [decoded(rest[0])];
    return [{ text: rest.join(" "), dialect: "powershell" }];
  }
  if (bin === "cmd") {
    if (flag < 0) return [];
    return cmdForms(args.slice(flag + 1).join(" ")).map((text) => ({ text, dialect: "auto" }));
  }
  if (bin === "for") return forLoop(args);
  return startedProcesses(bin, args, cmd).flatMap((p) => [p, ...startedShell(p, cmd)]);
}

const built = (text: string): boolean => holdsVariable(text) || holdsSubstitution(text);

/** PowerShell's `-EncodedCommand`, or any prefix of it (`-e`, `-ec`, `-enc`), maybe with `:value`. */
const ENCODED =
  /^[-/](?:ec|e(?:n(?:c(?:o(?:d(?:e(?:d(?:c(?:o(?:m(?:m(?:a(?:n(?:d)?)?)?)?)?)?)?)?)?)?)?)?)?)(?::.*)?$/is;
/** PowerShell's `-Command`, or any prefix of it, and pwsh's `-CommandWithArgs` (`-cwa`). */
const COMMAND = /^[-/](?:c(?:o(?:m(?:m(?:a(?:n(?:d(?:withargs)?)?)?)?)?)?)?|cwa)(?::.*)?$/is;
/** Windows PowerShell's options that take a value, before a command given without `-Command`. */
const PS_VALUED =
  /^[-/](?:ex|ep|executionpolicy|w|windowstyle|v|version|inputformat|if|outputformat|of|psconsolefile|configurationname|wd|workingdirectory|settingsfile|custompipename)$/i;

/**
 * The command Windows PowerShell is given without `-Command`: its first word that isn't an option
 * or an option's value, with the words after it (`powershell -NoProfile "Remove-Item x"`). `pwsh`
 * takes that word as a script file, and so does either after `-File`.
 */
function positional(bin: string, args: string[]): InlineScript[] {
  if (bin !== "powershell") return [];
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i] as string;
    if (/^[-/]f(?:i(?:l(?:e)?)?)?$/i.test(arg) || arg === "-") return [];
    if (PS_VALUED.test(arg)) i += 1;
    else if (!/^[-/][a-z]/i.test(arg)) {
      return [{ text: args.slice(i).join(" "), dialect: "powershell" }];
    }
  }
  return [];
}

/**
 * The script `-EncodedCommand` runs: base64 of UTF-16LE text. One that can't be decoded to text is
 * only known when it runs.
 */
function decoded(value: string | undefined): InlineScript {
  const unknown: InlineScript = { text: "", dialect: "powershell", dynamic: true };
  if (!value || !/^[A-Za-z0-9+/]+={0,2}$/.test(value) || value.length % 4 !== 0) return unknown;
  const text = Buffer.from(value, "base64").toString("utf16le");
  // biome-ignore lint/suspicious/noControlCharactersInRegex: binary data is not a script.
  return /[\u0000-\u0008\u000e-\u001f�]/.test(text)
    ? unknown
    : { ...unknown, text, dynamic: false };
}

/**
 * The word a shell's inline script follows: `-c` (also within `-lc`), `-Command`,
 * `-EncodedCommand` or cmd's `/c` and `/k` (Git Bash writes them `//c`, which its path conversion
 * leaves alone); -1 for none.
 */
export function scriptFlag(bin: string, args: readonly string[]): number {
  if (SHELLS.has(bin)) return args.findIndex((a) => /^-[a-z]*c[a-z]*$/i.test(a));
  if (bin === "pwsh" || bin === "powershell")
    return args.findIndex((a) => COMMAND.test(a) || ENCODED.test(a));
  if (bin === "cmd") return args.findIndex((a) => /^\/\/?[ck]$/i.test(a));
  return -1;
}

/**
 * The string `Invoke-Expression` runs: its words (after `-Command`), or the one string a pipe
 * hands it (`'Remove-Item x' | iex`). Anything else a pipe hands it is only known when it runs.
 */
function evaluated(args: string[], cmd: SimpleCommand, source?: SimpleCommand): InlineScript[] {
  // `-Command x`, or bound with a colon: `-Command:x`.
  const words = args
    .filter((a) => !/^-(c|co|com|comm|comma|comman|command)$/i.test(a))
    .map((a) => a.replace(/^-(c|co|com|comm|comma|comman|command):/i, ""));
  const piped = words.length === 0 && cmd.piped === true;
  const literal = piped && source?.words.length === 1 && source.nested.length === 0;
  const text = literal ? (source.words[0] as string) : words.join(" ");
  if (!text.trim() && !piped) return [];
  const dynamic = (piped && !literal) || EXPANDS.test(text) || (!piped && cmd.nested.length > 0);
  return [{ text, dialect: "powershell", dynamic }];
}

/**
 * The script of a shell `Start-Process` starts (#550). It joins the argument list with spaces into
 * the shell's command line, so `-ArgumentList '-c','irm … | iex'` runs `irm … | iex`, pipe and
 * all. Every word after the script flag is taken as the script, the way PowerShell and cmd read
 * it; a POSIX shell given them unquoted would run only the first, which asks no less.
 */
function startedShell(started: StartedProcess, cmd: SimpleCommand): InlineScript[] {
  const bin = binName(started.program);
  const words = commandLineWords(started.args.join(" "));
  const flag = scriptFlag(bin, words);
  if (flag < 0) return [];
  const script = words.slice(flag + 1).join(" ");
  return inlineScripts(bin, [...words.slice(0, flag + 1), script], cmd).map((inner) => ({
    ...inner,
    dir: started.dir,
    elevated: started.elevated,
  }));
}

/**
 * A command line split into words the way a Windows program reads it: spaces separate them,
 * double quotes group them (and `\"` is a quote).
 */
function commandLineWords(line: string): string[] {
  const words: string[] = [];
  let word: string | undefined;
  let quoted = false;
  for (let i = 0; i < line.length; i += 1) {
    const c = line[i] as string;
    if (c === "\\" && line[i + 1] === '"') {
      word = `${word ?? ""}"`;
      i += 1;
    } else if (c === '"') {
      quoted = !quoted;
      word ??= "";
    } else if (/\s/.test(c) && !quoted) {
      if (word !== undefined) words.push(word);
      word = undefined;
    } else word = (word ?? "") + c;
  }
  if (word !== undefined) words.push(word);
  return words;
}

/**
 * The forms `cmd /c` may run a command line in. When it starts with `"` (after spaces), cmd drops
 * that quote and the last one on the line, keeping only one quoted program path with spaces as
 * written (`"C:\Program Files\x.exe" arg`), so `"set AWS"` runs `set AWS`. Both forms are given.
 */
function cmdForms(text: string): string[] {
  const line = text.trim();
  if (!line.startsWith('"')) return [text];
  const last = line.lastIndexOf('"');
  return [text, last > 0 ? line.slice(1, last) + line.slice(last + 1) : line.slice(1)];
}

/** The `(…)` set of a `for` loop, maybe with `do` written right after it: `('set')do`. */
const SET = /^\(([\s\S]*)\)(do)?$/i;
/** A command a `for /f` loop reads: `'set AWS'`, or backquoted with `usebackq`. */
const QUOTED_COMMAND = /^(['`])([\s\S]*)\1$/;

/**
 * cmd's `for` loop: `for [/d | /r dir | /l | /f ["options"]] %i in (set) do command`. The command
 * after `do` runs for each item. `for /f` loops over lines, which it reads from a command's output
 * (`('set AWS')`, or `` (`set AWS`) `` with `usebackq`), from files (`(.env)`, or `("my file")` with
 * `usebackq`) or from a string (`("a b")`, or `('a b')` with `usebackq`). The lexer keeps the set
 * as written, so the command is parsed here; files are read as `type` reads them. Text in single
 * quotes or backquotes counts as a command whatever the switches and options say, so they can't
 * hide one. The loop runs it through `cmd /c`, which drops a leading `"` and the last one
 * (`('"set AWS"')` runs `set AWS`; `cmdForms`). cmd's `^` escapes (`'set AWS ^| findstr KEY'`) are
 * taken out. A POSIX `for` (`for f in *.txt; do`) has no `(…)` set and runs its body as commands
 * of their own.
 */
function forLoop(args: string[]): InlineScript[] {
  const lower = args.map((a) => a.toLowerCase());
  const at = lower.findIndex((w, i) => w === "in" && SET.test(args[i + 1] ?? ""));
  const set = SET.exec(args[at + 1] ?? "");
  if (at < 0 || !set) return [];
  const options = lower.slice(0, at);
  const lines = options.some((o) => o.startsWith("/f"));
  const usebackq = options.join(" ").includes("usebackq");
  const scripts: InlineScript[] = loopInput((set[1] as string).trim(), lines, usebackq).map(
    (text) => ({ text, dialect: "auto", feeds: true }),
  );
  const body = set[2] ? args.slice(at + 2) : doBody(args.slice(at + 2));
  if (body.length > 0) scripts.push({ text: uncaret(body.join(" ")), dialect: "auto" });
  return scripts;
}

/**
 * What a loop's set runs or reads, as command lines: its quoted command in each form `cmd /c` may
 * run it in, or `type` reading the files a `for /f` set names. A plain `for` only names its items.
 */
function loopInput(set: string, lines: boolean, usebackq: boolean): string[] {
  const command = QUOTED_COMMAND.exec(set);
  if (command) return cmdForms(uncaret(command[2] as string));
  if (!lines || set === "" || (set.startsWith('"') && !usebackq)) return [];
  return [`type ${uncaret(set)}`];
}

/** The words of the command after `do`: `do @echo %i`, or `do(set AWS)` written together. */
function doBody(rest: string[]): string[] {
  const first = rest[0]?.toLowerCase();
  if (first === "do") return rest.slice(1);
  if (first?.startsWith("do(")) return [(rest[0] as string).slice(2), ...rest.slice(1)];
  return [];
}

/** cmd's `^` escapes the character after it. */
const uncaret = (text: string) => text.replace(/\^([\s\S])/g, "$1");
