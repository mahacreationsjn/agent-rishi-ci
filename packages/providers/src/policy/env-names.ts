import { binName, DISCARD, unwrap } from "./command-words";
import { ENV_DRIVE, listsEnvironment } from "./env-dumps";
import type { SimpleCommand } from "./shell";

/**
 * Names-only environment listings (§11.2, #422, #448). Listing the environment counts as dumping
 * it (`listsEnvironment`), unless the pipeline after the listing keeps only the names and those
 * reach the agent: `… | Select-Object -ExpandProperty Name`, `… | ForEach-Object { $_.Name }`,
 * `(Get-ChildItem env:).Name`, `Get-ChildItem env: -Name`, `printenv -0 | cut -z -d= -f1` (or a
 * `sed -z` that drops `=` and the rest), or clearing the listed variables (`… | Remove-Item`,
 * `… | ForEach-Object { Remove-Item "Env:$($_.Name)" }`). Each stage after the listing is
 * followed. A stage this module doesn't know, one that mentions values or looks them up, a script
 * block that does more than compare (`Where-Object { Write-Host $_ }` prints every entry), one
 * that keeps the entries in a variable (`-OutVariable v`, which a later `$v` prints), one that
 * writes entries to a file, or names handed to another command (a substitution, an inline script
 * piped on) keeps the listing a dump. So does cutting lines at `=` (`printenv | cut -d= -f1`, the
 * same with `sed` or `awk -F=`, cmd's `for /f "delims=="` over `set`): a value that spans lines,
 * such as a private key, passes its other lines on whole. Only NUL-separated records
 * (`printenv -0`, `env -0`) end where a variable does.
 */

/**
 * Where a command list's output goes: shown to the agent, projected to names by the command it
 * sits in (`(…).Name`), or handed to another command (a substitution or piped inline script).
 */
export type ListOutput = "shown" | "names" | "feeds";

/**
 * What flows down a pipeline from a listing: entries (PowerShell's name/value items, or
 * `NAME=value` lines), NUL-separated `NAME=value` records (`printenv -0`), names, or nothing.
 */
type Flow = "entries" | "records" | "names" | "none";

/** The listings in a command list that only show names, and the `(…).Name` projections. */
export interface NamesOnly {
  /** Indexes of listings (`listsEnvironment`) whose pipeline keeps only the names. */
  listings: ReadonlySet<number>;
  /** Indexes of commands that project their first nested list to names: `(…).Name`. */
  projections: ReadonlySet<number>;
}

/** Words that mention a variable's value or may look one up. */
const LOOKUP = /value|environment|env:|getenv/i;
/** `printenv` and `env` options that end each variable with NUL instead of a newline. */
const NUL = /^(-0|--null)$/;
/**
 * Common parameters that keep a stage's output in a variable (`-OutVariable v`, `-ov:v`,
 * `-OutVar v`, `-PipelineVariable e`), which a later `$v` prints.
 */
const OUTPUT_VARIABLE = /^-(ov|pv|outv[a-z]*|pi[a-z]*)(:.*)?$/i;

const WHERE = new Set(["where-object", "where", "?"]);
const SORT = new Set(["sort-object", "sort"]);
const SELECT = new Set(["select-object", "select"]);
const FOREACH = new Set(["foreach-object", "foreach", "%"]);
const FORMAT = new Set(["format-table", "ft", "format-list", "fl", "format-wide", "fw"]);
const REMOVE = new Set(["remove-item", "ri", "rm", "del", "erase", "rd", "rmdir"]);
/** Line filters: they pass lines on (entries stay entries, names stay names). */
const LINES = new Set([
  "grep",
  "egrep",
  "fgrep",
  "findstr",
  "select-string",
  "sls",
  "head",
  "tail",
  "uniq",
]);
/** Commands that only reshape or show text, fine once just names flow. */
const TEXT = new Set([
  "cut",
  "tr",
  "wc",
  "column",
  "more",
  "less",
  "nl",
  "rev",
  "get-unique",
  "gu",
]);
const OUT = new Set(["out-string", "out-host", "out-default", "measure-object", "measure"]);

/** `(Get-ChildItem env:).Name`: one plain group (no quotes, no inner groups) and its names. */
const PROJECTION = /^\$?\(([^()'"`]*)\)\.(name|key)$/i;
/** `$_.Name` in a script block. */
const ITEM_NAME = /^\$(_|psitem)\.(name|key)$/i;
/** What a filter's script block may compare: the item, its name, or a variable (`$names`). */
const OPERAND = /^\$((_|psitem)(\.(name|key))?|[a-z]\w*)$/i;
const COMPARE =
  /^-[ci]?(eq|ne|gt|ge|lt|le|like|notlike|match|notmatch|contains|notcontains|in|notin)$/i;
const JOIN = /^-(and|or|xor)$/i;
const NEGATE = /^(-not|!)$/i;
/** The parameters that take a filter's script block: `Where-Object -FilterScript { … }`. */
const BLOCK_PARAMETER = /^-(filterscript|property)$/i;
/** The variable a removal in a script block names: `Env:$($_.Name)`, `Env:\$_`. */
const ITEM_VARIABLE = /^env:\\?(\$\(\$(_|psitem)\.(name|key)\)|\$(_|psitem))$/i;
/** Switches and named parameters a removal may carry; they print no values. */
const REMOVE_SWITCHES = new Set(["-force", "-verbose", "-whatif", "-recurse"]);
const REMOVE_NAMED = new Set(["-erroraction", "-ea"]);

const isName = (property: string) => /^(name|key)$/i.test(property);
const elements = (word = "") =>
  word
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

/** Which listings and projections of `list` only show names, given where its output goes. */
export function namesOnly(list: SimpleCommand[], output: ListOutput): NamesOnly {
  const listings = new Set<number>();
  const projections = new Set<number>();
  if (output === "feeds") return { listings, projections };
  const keeps = (flow: Flow | undefined) =>
    output === "shown" ? flow === "names" || flow === "none" : flow !== undefined;
  for (const [i, cmd] of list.entries()) {
    const from = source(cmd);
    if (from && keeps(flowFrom(list, i, from))) listings.add(i);
    if (projects(cmd) && keeps(flowFrom(list, i, "names"))) projections.add(i);
  }
  return { listings, projections };
}

/**
 * What a listing outputs: entries, NUL-separated records (`printenv -0`, `env -0`), or names
 * (`Get-ChildItem env: -Name`). `printenv` with no names only. Entries kept in a variable
 * (`-OutVariable v`) are not followed: a later `$v` prints them.
 */
function source(cmd: SimpleCommand): Flow | undefined {
  if (cmd.writes.some((w) => !DISCARD.test(w))) return undefined;
  const { tokens } = unwrap(cmd.words);
  const bin = binName(tokens[0]);
  const args = tokens.slice(1);
  if (bin === "printenv") {
    if (args.length === 0) return "entries";
    return args.length === 1 && NUL.test(args[0] as string) ? "records" : undefined;
  }
  if (!listsEnvironment(bin, args)) return undefined;
  if (bin === "env" && args.some((a) => NUL.test(a))) return "records";
  if (ENV_DRIVE.test(bin) && args.some((a) => a.toLowerCase() === "-name")) return "names";
  return keepsOutput(args) ? undefined : "entries";
}

const keepsOutput = (args: string[]) => args.some((a) => OUTPUT_VARIABLE.test(a));

/** `(…).Name` as the command, with no other substitution and no value in its operators. */
function projects(cmd: SimpleCommand): boolean {
  const [first, ...rest] = cmd.words;
  return (
    cmd.nested.length === 1 &&
    first !== undefined &&
    PROJECTION.test(first) &&
    !rest.some((w) => LOOKUP.test(w))
  );
}

/** What reaches the end of the pipeline that `list[i]` starts, from `flow`. */
function flowFrom(list: SimpleCommand[], i: number, flow: Flow): Flow | undefined {
  let current: Flow | undefined = flow;
  for (let j = i + 1; current && list[j]?.piped; j += 1) {
    current = stage(current, list[j] as SimpleCommand);
  }
  return current;
}

/** What one stage of the pipeline passes on; undefined when it may show or look up values. */
function stage(flow: Flow, cmd: SimpleCommand): Flow | undefined {
  if (flow === "none") return "none";
  if (flow === "entries" && cmd.writes.some((w) => !DISCARD.test(w))) return undefined;
  const { tokens } = unwrap(cmd.words);
  const bin = binName(tokens[0]);
  const args = tokens.slice(1);
  if (flow === "records") {
    const cuts = bin === "cut" ? cutsName(args) : bin === "sed" && stripsValue(args);
    return cuts && cmd.nested.length === 0 ? "names" : undefined;
  }
  if (flow === "entries" && keepsOutput(args)) return undefined;
  // A removal's `Env:$($_.Name)` is a substitution; it is classified on its own.
  if (FOREACH.has(bin)) return forEach(args, cmd.nested.length > 0);
  if (cmd.nested.length > 0) return undefined;
  if (WHERE.has(bin) || SORT.has(bin)) return filters(args) ? flow : undefined;
  if (SELECT.has(bin)) return select(flow, args);
  if (FORMAT.has(bin)) return format(flow, args);
  if (REMOVE.has(bin)) return flow === "entries" && onlyRemoveOptions(args) ? "none" : undefined;
  if (LINES.has(bin)) return flow;
  if (flow === "names") return TEXT.has(bin) || OUT.has(bin) ? "names" : undefined;
  return undefined;
}

/**
 * `Where-Object` and `Sort-Object` arguments that only pick or order: properties and operators
 * (`Where-Object Name -like 'AGENT_RISHI*'`), or one script block that only compares
 * (`{ $_.Name -like 'AGENT_RISHI*' -and $_.Name -ne 'AGENT_RISHI_HOME' }`). A block that runs a command
 * (`{ Write-Host $_ }`, `{ Out-Host -InputObject $_ }`) prints each entry it is given.
 */
function filters(args: string[]): boolean {
  if (args.some((a) => LOOKUP.test(a))) return false;
  const open = args.findIndex((a) => /[{}]/.test(a));
  if (open === -1) return true;
  const before = args.slice(0, open);
  if (before.length > 1 || (before.length === 1 && !BLOCK_PARAMETER.test(before[0] as string))) {
    return false;
  }
  const inner = scriptBlock(args.slice(open));
  return inner !== undefined && comparesOnly(inner);
}

/**
 * A script block's words that only compare: operands (`$_`, `$_.Name`, a variable), each maybe
 * negated and compared with a value (`-like 'AGENT_RISHI*'`), joined by `-and`, `-or`, `-xor`. A
 * command can start only where an operand stands, so none runs. The word after an operator is
 * a value: PowerShell runs no command there.
 */
function comparesOnly(words: string[]): boolean {
  let i = 0;
  for (;;) {
    while (NEGATE.test(words[i] ?? "")) i += 1;
    if (!OPERAND.test(words[i] ?? "")) return false;
    i += 1;
    if (COMPARE.test(words[i] ?? "")) {
      if (i + 1 >= words.length) return false;
      i += 2;
    }
    if (i === words.length) return true;
    if (!JOIN.test(words[i] as string)) return false;
    i += 1;
  }
}

/**
 * `ForEach-Object { $_.Name }`, `ForEach-Object Name` or `-MemberName Name` pass names on;
 * `ForEach-Object { Remove-Item "Env:$($_.Name)" }` clears the variables and passes nothing.
 */
function forEach(args: string[], nested: boolean): Flow | undefined {
  const inner = scriptBlock(args);
  if (inner) {
    if (removesItem(inner)) return "none";
    return !nested && inner.length === 1 && ITEM_NAME.test(inner[0] as string)
      ? "names"
      : undefined;
  }
  if (nested) return undefined;
  const member = args[0]?.toLowerCase() === "-membername" ? args.slice(1) : args;
  return member.length === 1 && isName(member[0] as string) ? "names" : undefined;
}

/** The words inside `{ … }` when the arguments are exactly one script block. */
function scriptBlock(args: string[]): string[] | undefined {
  const first = args[0];
  const last = args.at(-1);
  if (!first?.startsWith("{") || !last?.endsWith("}")) return undefined;
  const words =
    args.length === 1
      ? [first.slice(1, -1)]
      : [first.slice(1), ...args.slice(1, -1), last.slice(0, -1)];
  const inner = words.map((w) => w.trim()).filter(Boolean);
  return inner.some((w) => /[{}]/.test(w)) ? undefined : inner;
}

/** `Remove-Item [-Path] Env:$($_.Name) [-ErrorAction X] [-Force]`. */
function removesItem(words: string[]): boolean {
  if (!REMOVE.has(binName(words[0]))) return false;
  const args = words.slice(1);
  const at = /^-(path|literalpath)$/i.test(args[0] ?? "") ? 1 : 0;
  return ITEM_VARIABLE.test(args[at] ?? "") && onlyRemoveOptions(args.slice(at + 1));
}

function onlyRemoveOptions(args: string[]): boolean {
  for (let i = 0; i < args.length; i += 1) {
    const arg = (args[i] as string).toLowerCase();
    if (REMOVE_NAMED.has(arg)) i += 1;
    else if (!REMOVE_SWITCHES.has(arg)) return false;
  }
  return true;
}

/** `Select-Object` keeping only `Name` (or `-First 5`, `-Unique`, which keep what flows). */
function select(flow: Flow, args: string[]): Flow | undefined {
  const named: string[] = [];
  for (let i = 0; i < args.length; i += 1) {
    const arg = (args[i] as string).toLowerCase();
    if (/^-(expandproperty|expand|exp|property|prop)$/.test(arg)) {
      named.push(...elements(args[i + 1]));
      i += 1;
    } else if (/^-(first|last|skip)$/.test(arg)) {
      if (!/^\d+$/.test(args[i + 1] ?? "")) return undefined;
      i += 1;
    } else if (arg !== "-unique") {
      if (arg.startsWith("-")) return undefined;
      named.push(...elements(args[i]));
    }
  }
  if (named.length === 0) return flow;
  return named.every(isName) ? "names" : undefined;
}

/** `Format-Table Name`: a table of names. Without properties it shows what flows. */
function format(flow: Flow, args: string[]): Flow | undefined {
  const named: string[] = [];
  for (let i = 0; i < args.length; i += 1) {
    const arg = (args[i] as string).toLowerCase();
    if (/^-(property|prop)$/.test(arg)) {
      named.push(...elements(args[i + 1]));
      i += 1;
    } else if (!["-autosize", "-hidetableheaders", "-wrap"].includes(arg)) {
      if (arg.startsWith("-")) return undefined;
      named.push(...elements(args[i]));
    }
  }
  if (named.length === 0) return flow === "names" ? "names" : undefined;
  return named.every(isName) ? "names" : undefined;
}

/**
 * `cut -z -d= -f1` (or `-zd=`, `-d '='`, `--delimiter==`, `-f 1`, `--fields=1`,
 * `--zero-terminated`): the names of NUL-separated `NAME=value` records. Without `-z`, `cut`
 * splits at newlines, inside a value that spans lines.
 */
function cutsName(args: string[]): boolean {
  let delimiter: string | undefined;
  let fields: string | undefined;
  let zero = false;
  for (let i = 0; i < args.length; i += 1) {
    let arg = args[i] as string;
    if (/^-z./.test(arg)) {
      zero = true;
      arg = `-${arg.slice(2)}`;
    }
    const d = /^(?:-d|--delimiter=?)(.*)$/.exec(arg);
    const f = /^(?:-f|--fields=?)(.*)$/.exec(arg);
    if (arg === "-z" || arg === "--zero-terminated") zero = true;
    else if (d) delimiter = d[1] || args[++i];
    else if (f) fields = f[1] || args[++i];
    else return false;
  }
  return zero && delimiter === "=" && fields === "1";
}

/**
 * `sed -z` with one script that drops `=` and the rest of the record: `s`, a delimiter, `=.*`,
 * then the delimiter twice (any delimiter; `$` before it and `g` after optional; `-e`, `-E`, `-r`
 * allowed). `-z` (`--null-data`) reads NUL-separated records, where `.*` runs to the record's end.
 */
function stripsValue(args: string[]): boolean {
  const scripts: string[] = [];
  let zero = false;
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i] as string;
    if (arg === "-z" || arg === "--null-data" || arg === "--zero-terminated") zero = true;
    else if (arg === "-e" || arg === "--expression") scripts.push(args[++i] ?? "");
    else if (arg === "-E" || arg === "-r" || arg === "--regexp-extended") continue;
    else if (arg.startsWith("-") || scripts.length > 0) return false;
    else scripts.push(arg);
  }
  return zero && scripts.length === 1 && /^s(.)=\.\*\$?\1\1g?$/.test(scripts[0] as string);
}
