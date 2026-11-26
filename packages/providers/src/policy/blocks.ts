import { binName, DISCARD, FUNCTION_NAME, unwrap } from "./command-words";
import { inlineScripts } from "./inline-scripts";
import { locationsAfter, MAX_LOCATIONS } from "./locations";
import type { PathContext } from "./paths";
import { programDenial } from "./read-only";
import type { SimpleCommand } from "./shell";
import { shellReadings } from "./shell-readings";

/**
 * Commands a command line runs through braces and functions (§11.2): a PowerShell script block
 * (`if (…) { … }`, `try { … } catch { … }`, `foreach (…) { … }`, `& { … }`, `. { … }`), and the
 * body of a function where it is called (`f() { rm -rf x; }; f`, `function f { … }; f`). The risk
 * classifier judges each like the commands around it, in the folder the shell is in at that point,
 * and follows the folder changes they make (`if (…) { cd .. }; git clean -fdx`).
 */

/** The functions a command line defines, by lower-cased name: the commands of each body. */
export type FunctionTable = ReadonlyMap<string, SimpleCommand[]>;

/** A context that carries the functions defined so far. */
export interface WithFunctions {
  /** Set by the classifier as it reads a command line; callers leave it out. */
  functions?: FunctionTable;
}

const NO_COMMAND: SimpleCommand = { words: [], writes: [], nested: [] };

/** The header of a POSIX function definition: `f()`, or `f(){` written together. */
const HEADER = /^([A-Za-z_][\w-]*)\(\)\{?$/;

/** The function `cmd` starts to define: its name, and how many words its header takes. */
function definition(cmd: SimpleCommand): { name: string; header: number } | undefined {
  const [first = "", second, third] = cmd.words;
  const posix = HEADER.exec(first);
  if (posix?.[1]) return { name: posix[1].toLowerCase(), header: 1 };
  // `f () { … }`: the name and its parentheses written apart.
  if (second === "()" && FUNCTION_NAME.test(first)) return { name: first.toLowerCase(), header: 2 };
  const keyword = first.toLowerCase();
  if ((keyword !== "function" && keyword !== "filter") || !second) return undefined;
  // PowerShell: `function global:f($a) { … }`.
  const name = second.replace(/\(.*$/s, "").replace(/^\w+:/, "").toLowerCase();
  return name ? { name, header: third === "()" ? 3 : 2 } : undefined;
}

/**
 * `ctx` with the functions `list` defines, also inside its blocks. A body in braces the lexer read
 * as a block is that block; in a POSIX shell, whose braces stay words, it is the commands up to
 * the one that starts with `}`.
 */
export function withFunctions<T extends WithFunctions>(list: SimpleCommand[], ctx: T): T {
  const found = new Map(ctx.functions);
  const before = found.size;
  collect(list, found);
  return found.size === before && !definesAgain(list, ctx) ? ctx : { ...ctx, functions: found };
}

/** True when `list` defines a function the context already has (the new body replaces it). */
function definesAgain(list: SimpleCommand[], ctx: WithFunctions): boolean {
  return list.some((cmd) => ctx.functions?.has(definition(cmd)?.name ?? "") === true);
}

function collect(list: SimpleCommand[], found: Map<string, SimpleCommand[]>): void {
  for (const [i, cmd] of list.entries()) {
    for (const block of cmd.blocks ?? []) collect(block, found);
    const def = definition(cmd);
    if (!def) continue;
    if (cmd.blocks?.length) {
      found.set(def.name, cmd.blocks.flat());
      continue;
    }
    const first = { ...cmd, words: cmd.words.slice(def.header) };
    const body = [first];
    // The body goes on in the next commands: after `{`, or when it starts on the next line.
    if (first.words[0] === "{" || cmd.words[0]?.endsWith("{") || first.words.length === 0) {
      for (const next of list.slice(i + 1)) {
        if (next.words[0] === "}") break;
        body.push(next);
      }
    }
    found.set(def.name, body);
  }
}

/** The body of the function `cmd` calls (`f`, `f arg`, `. f`), and its name; none otherwise. */
function called(cmd: SimpleCommand, ctx: WithFunctions): [string, SimpleCommand[]] | undefined {
  if (!ctx.functions?.size || definition(cmd)) return undefined;
  const { tokens } = unwrap(cmd.words);
  const word = tokens[0] === "." || tokens[0] === "&" ? tokens[1] : tokens[0];
  const name = word?.toLowerCase() ?? "";
  const body = ctx.functions.get(name);
  return body ? [name, body] : undefined;
}

/**
 * The command lists `cmd` runs beside itself, each with the context to judge it in: its blocks,
 * and the body of a function it calls, which is judged without that function, so one that calls
 * itself ends.
 */
export function ranLists<T extends WithFunctions>(
  cmd: SimpleCommand,
  ctx: T,
): Array<{ list: SimpleCommand[]; ctx: T }> {
  const out = (cmd.blocks ?? []).map((list) => ({ list, ctx }));
  const call = called(cmd, ctx);
  if (call) {
    const functions = new Map(ctx.functions);
    functions.delete(call[0]);
    out.push({ list: call[1], ctx: { ...ctx, functions } });
  }
  return out;
}

/** The programs that run a string in the shell itself, so its folder changes stay. */
const EVALS = new Set(["eval", "iex", "invoke-expression"]);

/** The command lists the string `cmd` evaluates holds (`eval 'cd ..'`), in each reading. */
function evaluated(cmd: SimpleCommand, ctx: PathContext): SimpleCommand[][] {
  const { tokens } = unwrap(cmd.words);
  const bin = binName(tokens[0]);
  if (!EVALS.has(bin)) return [];
  return inlineScripts(bin, tokens.slice(1), cmd).flatMap((script) =>
    shellReadings(script.text, script.dialect, ctx),
  );
}

/**
 * Every location the shell may be in after `cmd`, from each of `ctxs`: where `cmd` itself moves
 * (`./locations`), and where its blocks, a function it calls and a string it evaluates may, since
 * they may run or not.
 */
export function locationsThrough<T extends PathContext & WithFunctions>(
  cmd: SimpleCommand,
  ctxs: readonly T[],
): T[] {
  let out = locationsAfter(cmd, ctxs);
  for (const here of ctxs) {
    const strings = evaluated(cmd, here).map((list) => ({ list, ctx: here }));
    for (const ran of [...ranLists(cmd, here), ...strings]) {
      let inner: T[] = [ran.ctx];
      for (const one of ran.list) {
        inner = locationsThrough(one, inner);
        if (inner.length > MAX_LOCATIONS) return [...out, ...inner];
      }
      // Back with the functions the outer list knows.
      const back = inner.map((c) => ({ ...c, functions: here.functions }));
      out = locationsAfter(NO_COMMAND, [...out, ...back]);
      if (out.length > MAX_LOCATIONS) return out;
    }
  }
  return out;
}

/**
 * True when every command of `list` only reads (`./read-only`'s rules), with no redirect to a
 * file, substitution or block: what a script built when it runs must be to run without asking.
 */
export function listOnlyReads(list: SimpleCommand[]): boolean {
  if (list.length === 0) return false;
  return list.every((cmd) => {
    const { tokens, elevated } = unwrap(cmd.words);
    if (elevated || cmd.nested.length > 0 || cmd.blocks?.length) return false;
    if (cmd.writes.some((target) => !DISCARD.test(target))) return false;
    return programDenial(binName(tokens[0]), tokens.slice(1)) === undefined;
  });
}
