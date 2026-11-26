import { binName, unwrap } from "./command-words";
import { namesCurrentFolder } from "./current-folder";
import { hereLength, isWin, type PathContext } from "./paths";
import type { SimpleCommand } from "./shell";

/**
 * Variables a command line sets and then uses (§11.2). `x=/other; rm -rf $x` deletes `/other`, so
 * a plain value assigned earlier on the command line is filled in where a later command expands it
 * (`resolveVariables`), and every rule then reads the path. A variable set more than once may hold
 * any of its values (a branch may or may not run), so the command is judged with each; one set
 * from something only known when the command runs (`x=$1`, `read x`, `x=$(…)`) stays as written.
 *
 * A write or delete target that still holds a variable or a parameter afterwards (`rm -rf "$1"`,
 * `> $out`) names a path only known when the command runs: it counts as outside the worktree
 * (`unresolvedTarget`), like a folder a `cd $X` lands in. Reads are left alone.
 */

/** A variable's values: each plain value it may hold, or null when one is only known at run time. */
type Table = Map<string, readonly string[] | null>;

/** More values than this for one variable are not followed. */
const MAX_VALUES = 8;

/** `$x`, `${x}`; not `$env:X` or a longer name. */
const REFERENCE = /\$\{([A-Za-z_]\w*)\}|\$([A-Za-z_]\w*)(?![\w:])/g;
/** `${TMPDIR:-/tmp}`: the temp folder either way. */
const TEMP_DEFAULT = /\$\{(?:TMPDIR|TEMP|TMP):?-[^}]*\}/g;
const ASSIGNMENT = /^([A-Za-z_]\w*)=(.*)$/s;
/** Builtins that declare variables: `export x=1`, `local x=1`. */
const DECLARES = new Set(["export", "local", "declare", "typeset", "readonly"]);
/** A word that sets a variable some other way: `read x`, `printf -v x`, `x+=y`, `x[0]=y`. */
const MENTION = /^([A-Za-z_]\w*)(\+=.*|\[.*)?$/s;
/** One PowerShell variable assigned with `=`: `$x = `, `[string]$script:x = `. */
const PS_TARGET = /^\s*(?:\[[^\]]*\]\s*)*\$(?:\w+:)?(\w+)\s*=\s*$/;
/** A whole substitution: `$(…)` or backticks. */
const SUBSTITUTION = /^(?:\$\(.*\)|`.*`)$/s;
/** `$(pwd)` or `` `pwd` `` at the start of a value, followed by its end or a `/`. */
const HERE = /^(?:\$\(\s*pwd\s*\)|`\s*pwd\s*`)(?=$|\/)/;

/**
 * `list` with the variables it assigns filled in where later commands expand them, also inside
 * its substitutions and blocks. A command that uses a variable with several values is repeated,
 * once for each, unless it stands in a pipe (its place there matters).
 */
export function resolveVariables(list: SimpleCommand[], table: Table = new Map()): SimpleCommand[] {
  const out: SimpleCommand[] = [];
  for (const [i, cmd] of list.entries()) {
    const piped = cmd.piped === true || list[i + 1]?.piped === true;
    const copies = filled(cmd, table, piped);
    for (const copy of copies) {
      copy.nested = copy.nested.map((inner) => resolveVariables(inner, new Map(table)));
      if (copy.blocks) copy.blocks = copy.blocks.map((inner) => resolveVariables(inner, table));
      if (table.size > 0) copy.scope = new Map(table);
      out.push(copy);
    }
    assign(copies[0] ?? cmd, table);
  }
  return out;
}

/** `cmd` with the known variables in its expanding words filled in: one copy for each value. */
function filled(cmd: SimpleCommand, table: Table, piped: boolean): SimpleCommand[] {
  if (!cmd.vars?.size) return [cmd];
  const several = new Set<string>();
  for (const word of cmd.vars) {
    for (const match of word.matchAll(REFERENCE)) {
      const name = keyOf((match[1] ?? match[2]) as string, table);
      if (name !== undefined && (table.get(name)?.length ?? 0) > 1) several.add(name);
    }
  }
  const one = (name: string): string | undefined => {
    const values = table.get(name);
    return values?.length === 1 ? values[0] : undefined;
  };
  const [spread] = several;
  if (several.size !== 1 || piped || spread === undefined) return [substitute(cmd, table, one)];
  return (table.get(spread) ?? []).map((value) =>
    substitute(cmd, table, (name) => (name === spread ? value : one(name))),
  );
}

/** The table's name for a variable as written: as it is, or PowerShell's, in any case. */
function keyOf(written: string, table: Table): string | undefined {
  if (table.has(written)) return written;
  const ps = `ps:${written.toLowerCase()}`;
  return table.has(ps) ? ps : undefined;
}

function substitute(
  cmd: SimpleCommand,
  table: Table,
  value: (name: string) => string | undefined,
): SimpleCommand {
  const vars = new Set<string>();
  const quoted = new Set(cmd.quoted);
  const fill = (word: string): string => {
    if (!cmd.vars?.has(word)) return word;
    const text = word.replace(TEMP_DEFAULT, "$TMPDIR").replace(REFERENCE, (ref, braced, bare) => {
      const written = (braced ?? bare) as string;
      const name = keyOf(written, table);
      // `$PWD`, unless the command line set it, stays: `./paths` puts where the shell is in its
      // place, where it is used (`./current-folder`).
      if (name === undefined) return ref;
      return value(name) ?? ref;
    });
    if (text.includes("$") || text.includes("`")) vars.add(text);
    if (cmd.quoted?.has(word)) quoted.add(text);
    return text;
  };
  // An unquoted `$x` alone is split into words: `x='rm -rf /other'; $x`, `o='-rf /other'; rm $o`.
  const split = (word: string): string[] => {
    const text = fill(word);
    const whole = text !== word && WHOLE.test(word) && !cmd.quoted?.has(word);
    return whole && /\s/.test(text.trim()) ? text.trim().split(/\s+/) : [text];
  };
  const words = cmd.words.flatMap(split);
  const out = { ...cmd, words, writes: cmd.writes.map(fill), vars, quoted };
  return cmd.input ? { ...out, input: cmd.input.map(fill) } : out;
}

/** A word that is one variable and nothing else. */
const WHOLE = /^\$(?:\{[A-Za-z_]\w*\}|[A-Za-z_]\w*)$/;

/** Note what `cmd` assigns, or sets some other way, in `table`. */
function assign(cmd: SimpleCommand, table: Table): void {
  if (cmd.assignedTo !== undefined) {
    // PowerShell: `$x = 'C:\other'`. Anything else on either side is only known when it runs.
    const value = PS_TARGET.test(cmd.assignedTo) ? psValue(cmd) : undefined;
    for (const match of cmd.assignedTo.matchAll(/\$(?:\w+:)?(\w+)/g)) {
      set(table, `ps:${(match[1] as string).toLowerCase()}`, value === undefined ? null : [value]);
    }
    return;
  }
  // Past keywords and a function's header: `then x=/other`, `f() { x=/other`.
  const { tokens: words, assigns } = unwrap(cmd.words);
  const head = words[0] ?? "";
  if (head === "for" && words[2] === "in" && /^[A-Za-z_]\w*$/.test(words[1] ?? "")) {
    const items = words.slice(3);
    const plain = items.length > 0 && items.every((item) => isPlain(cmd, item));
    set(table, words[1] as string, plain ? items : null);
    return;
  }
  const declares = DECLARES.has(head);
  const given = declares ? words.slice(1).filter((w) => !w.startsWith("-")) : assigns;
  if (declares || (words.length === 0 && given.length > 0)) {
    for (const word of given) {
      const match = ASSIGNMENT.exec(word);
      if (match) set(table, match[1] as string, assigned(cmd, word, match[2] as string, given));
      else if (head === "local" || head === "declare" || head === "typeset") set(table, word, null);
    }
    return;
  }
  for (const [k, word] of words.entries()) {
    const mention = MENTION.exec(word);
    const name = mention?.[1];
    if (name !== undefined && table.has(name) && (k > 0 || mention?.[2])) table.set(name, null);
  }
}

/** The plain values an assignment gives, or null when its value is only known when it runs. */
function assigned(
  cmd: SimpleCommand,
  word: string,
  value: string,
  given: string[],
): string[] | null {
  if (isPlain(cmd, word)) return [value];
  // `here=$(pwd)`, `d=$(pwd)/dist`: a path from where the shell is, kept as written for `./paths`
  // to fill in where it is used. Not as `.`: `"$here../x"` is beside that folder, not in it.
  const here = HERE.exec(value)?.[0].length ?? 0;
  const rest = value.slice(here);
  if (here > 0 && !holdsVariable(rest) && !holdsSubstitution(rest)) return [value];
  // `tmp=$(mktemp -d)`: a new folder in temp.
  const [inner] = cmd.nested;
  const ran = inner?.length === 1 ? unwrap((inner[0] as SimpleCommand).words).tokens : [];
  if (given.length !== 1 || cmd.nested.length !== 1 || !SUBSTITUTION.test(value)) return null;
  if (binName(ran[0]) !== "mktemp") return null;
  const args = ran.slice(1);
  if (args.some((a) => /^(-p|--tmpdir)/.test(a))) return null;
  const template = args.find((a) => !a.startsWith("-"));
  return [template !== undefined && !args.includes("-t") ? template : "$TMPDIR/mktemp"];
}

/**
 * The value a PowerShell assignment gives: its one plain word (`$x = 'C:\other'`), or the path
 * `Join-Path` makes of two (`$f = Join-Path $env:TEMP 'msg.txt'`).
 */
function psValue(cmd: SimpleCommand): string | undefined {
  const [first = "", ...rest] = cmd.words;
  if (rest.length === 0) {
    // A bare word is a command PowerShell runs (`$x = Get-Location`), not a value.
    const quoted = [...(cmd.quoted ?? [])].some((word) => word.endsWith(first));
    const text = quoted && isPlain(cmd, first);
    return text ? first : PS_TEMP_FILE.test(first) ? "$env:TEMP\\tmp" : undefined;
  }
  const [parent, child] = rest.map((word) =>
    PS_TEMP_FOLDER.test(word) ? "$env:TEMP" : isPlain(cmd, word) ? word : undefined,
  );
  const joins = rest.length === 2 && first.toLowerCase() === "join-path";
  if (!joins || !parent || !child || parent.startsWith("-") || child.startsWith("-")) {
    return undefined;
  }
  return `${parent.replace(/[\\/]+$/, "")}\\${child}`;
}

/** PowerShell's new temp file: `New-TemporaryFile`, `[IO.Path]::GetTempFileName()`. */
const PS_TEMP_FILE = /^(?:New-TemporaryFile|\[(?:System\.)?IO\.Path\]::GetTempFileName\(\))$/i;
/** PowerShell's temp folder: `[IO.Path]::GetTempPath()`, in parentheses or not. */
const PS_TEMP_FOLDER = /^\(?\[(?:System\.)?IO\.Path\]::GetTempPath\(\)\)?$/i;

/**
 * True when `word` is a value known as written: no substitution in `cmd`, and no variable but
 * the ones the path rules know (`$TMPDIR/x`, `$env:TEMP\x`).
 */
const isPlain = (cmd: SimpleCommand, word: string): boolean =>
  (cmd.nested.length === 0 || !/[(`]/.test(word)) &&
  !word.includes("`") &&
  !(cmd.vars?.has(word) && holdsVariable(word));

/**
 * Give `name` its `values`. A second assignment adds to the first, since either may be the one
 * that ran; a value only known at run time (null) stays.
 */
function set(table: Table, name: string, values: string[] | null): void {
  const before = table.get(name);
  if (values === null || before === null) return void table.set(name, null);
  const all = [...new Set([...(before ?? []), ...values])];
  table.set(name, all.length > MAX_VALUES ? null : all);
}

/**
 * Where a name of where the shell is (`$PWD`, `$(pwd)`) may end: the end, a separator, a quote,
 * a space or the shell's punctuation. Followed by anything else (`$PWD../x`), it is part of another
 * name, only known when the command runs.
 */
const ENDS = String.raw`(?=$|[\\/"'\s;&|)])`;

/**
 * Variables whose value the path rules know (`./paths`), or that name where the shell is or what
 * a pipe hands a block (`$_`): not a path built when the command runs. PowerShell's own values
 * (`$_`, `$PSItem`, with properties, `$null`, `$true`, `$false`) only as a whole word
 * (`Remove-Item $_`, `> $null`): `./paths` puts no folder in their place, and a POSIX shell (or
 * PowerShell, for `$null`) expands them to nothing, so `"$null/home/me/x"` is `/home/me/x`.
 */
const KNOWN = [
  /\$(?:HOME|\{HOME\})(?!\w)/gi,
  /\$(?:env:(?:USERPROFILE|TEMP|TMP|AGENT_RISHI_HOME)|\{env:(?:USERPROFILE|TEMP|TMP|AGENT_RISHI_HOME)\})(?!\w)/gi,
  /\$(?:TMPDIR|TEMP|TMP|AGENT_RISHI_HOME|\{(?:TMPDIR|TEMP|TMP|AGENT_RISHI_HOME)\})(?!\w)/g,
  new RegExp(String.raw`\$(?:PWD|\{PWD\})${ENDS}`, "gi"),
  /(?<![^\s"'=(,;|{])\$(?:(?:_|PSItem)(?:\.\w+)*|null|true|false)(?=$|[\s"'),;|}])/gi,
  /%(?:USERPROFILE|TEMP|TMP|AGENT_RISHI_HOME|CD)%/gi,
];
/** A variable or a parameter: `$x`, `${x…}`, `$1`, `$@`, `$*`. */
const VARIABLE = /\$(?:[A-Za-z_]\w*|\{[^}]+\}|[0-9@*])/;
/** cmd's `%NAME%`. */
const CMD_VARIABLE = /%[A-Za-z_]\w*%/;

const withoutKnown = (text: string): string =>
  KNOWN.reduce((rest, known) => rest.replace(known, ""), text);

/** True when `text` holds a variable or a parameter whose value the path rules don't know. */
export const holdsVariable = (text: string): boolean => VARIABLE.test(withoutKnown(text));

/**
 * Substitutions whose output stays where the path already points: the folder the shell is in, the
 * repository's top folder or a new temp file, ending there (`ENDS`), or a part of a name
 * (`log-$(date +%F).txt`).
 */
const KNOWN_OUTPUT = [
  new RegExp(
    String.raw`(?:\$\((?:pwd|Get-Location|git rev-parse --show-toplevel|mktemp(?: -d)?(?: [\w.-]*X{3,}[\w.-]*)?|\$(?:PWD(?:\.Path)?|env:TE?MP))\)|${"`"}pwd${"`"})${ENDS}`,
    "gi",
  ),
  /\$\((?:date(?: [^()`$]*)?|basename [^()`$]*|\$(?:_|PSItem)(?:\.\w+)*)\)/gi,
];

/** True when `text` holds a substitution whose output isn't known: `$(cat list)`, backticks. */
export const holdsSubstitution = (text: string): boolean =>
  /\$\(|`/.test(KNOWN_OUTPUT.reduce((rest, known) => rest.replace(known, ""), text));

/**
 * True when `target`, a path `cmd` writes or deletes, still holds a variable, a parameter or a
 * substitution the shell fills in when the command runs: where it points is only known then. A
 * name of where the shell is at its start (`$(pwd)/dist`) is known only where `./paths` can put
 * that folder in its place (`hereLength`): not `$pwd` in a POSIX shell, `$PWD../x`, or `$(pwd)`
 * once the command line redefines `pwd`.
 */
export function unresolvedTarget(cmd: SimpleCommand, target: string, ctx: PathContext): boolean {
  const here = hereLength(target, ctx);
  const rest = target.slice(here);
  if (isWin(ctx) && CMD_VARIABLE.test(withoutKnown(rest))) return true;
  const built =
    (here === 0 && namesCurrentFolder(target)) || holdsVariable(rest) || holdsSubstitution(rest);
  if (!built || !cmd.vars) return false;
  for (const word of cmd.vars) if (word.includes(target) || target.includes(word)) return true;
  return false;
}

/** Why an unresolved target asks. */
export const UNRESOLVED = "a path only known when the command runs";
