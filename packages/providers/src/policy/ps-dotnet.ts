import type { SimpleCommand } from "./shell";
import { holdsVariable } from "./variables";

/**
 * Files PowerShell writes or deletes without a cmdlet (§11.2), through .NET's static methods:
 * `[IO.File]::Delete('x')`, `[IO.Directory]::Delete('x', $true)`, `[IO.File]::WriteAllText(…)`,
 * `::Move`, `::Copy` and their kin, also written `[System.IO.File]`. The risk classifier judges
 * each path they are given as a write, and a file one reads (`ReadAllText`, the source of a `Copy`)
 * as a read, so a secrets file asks. A string the other `System.IO` types are handed
 * (`[IO.StreamReader]::new('x')`, `[IO.FileStream]::new('x', 'Open')`) counts as a read too.
 */

/** What the .NET calls in a command change. */
export interface DotnetWrites {
  /** The paths, as written. */
  targets: string[];
  /** True when one is what a pipe hands the block (`$_`): the items the pipeline lists. */
  piped: boolean;
  /** True when one is built when the command runs (a variable, an expression). */
  unknown: boolean;
  /** The paths the calls only read (`ReadAllText`, `OpenRead`, the source of a `Copy`). */
  reads: string[];
}

/** A static call on `File` or `Directory`: the method, then its arguments up to the `)`. */
const CALL = /\[\s*(?:System\.)?IO\.(?:File|Directory)\s*\]\s*::\s*(\w+)\s*\(/gi;
/**
 * A static call or constructor on another `System.IO` type (`[IO.StreamReader]::new(`), or one
 * built with its arguments in brackets (`New-Object IO.StreamReader('x')`).
 */
const OTHER_CALL = new RegExp(
  [
    String.raw`\[\s*(?:System\.)?IO\.(?!(?:File|Directory)\s*\])\w+\s*\]\s*::\s*\w+\s*\(`,
    String.raw`\bNew-Object\s+(?:-TypeName\s+)?(?:System\.)?IO\.\w+\s*\(`,
  ].join("|"),
  "gi",
);
/** Methods that change the path they are given first. */
const CHANGES = /^(?:Delete|Write\w*|Append\w*|Create\w*|Open|OpenWrite|Encrypt|Decrypt|Set\w+)$/i;

/** The positions of the arguments `method` writes or deletes. */
function written(method: string): number[] {
  if (/^(?:Move|Replace)$/i.test(method)) return [0, 1];
  if (/^Copy$/i.test(method)) return [1];
  return CHANGES.test(method) && !/^SetCurrentDirectory$/i.test(method) ? [0] : [];
}

/** The positions of the arguments `method` reads: a file's text, or the source of a copy. */
const read = (method: string): number[] =>
  /^(?:Read\w*|OpenRead|OpenText|Open|Copy|Move|GetFiles|EnumerateFiles)$/i.test(method) ? [0] : [];

/** The arguments of a call whose `(` is just before `from`: split at its commas, quotes kept. */
function argumentsAt(text: string, from: number): string[] {
  const out: string[] = [];
  let depth = 0;
  let quote = "";
  let arg = "";
  for (let i = from; i < text.length; i += 1) {
    const c = text[i] as string;
    if (quote) quote = c === quote ? "" : quote;
    else if (c === "'" || c === '"') quote = c;
    else if (c === "(") depth += 1;
    else if (c === ")" && depth === 0) break;
    else if (c === ")") depth -= 1;
    else if (c === "," && depth === 0) {
      out.push(arg.trim());
      arg = "";
      continue;
    }
    arg += c;
  }
  return [...out, arg.trim()];
}

/** The paths the .NET file calls in `cmd` write or delete. */
export function dotnetWrites(cmd: SimpleCommand): DotnetWrites {
  const found: DotnetWrites = { targets: [], piped: false, unknown: false, reads: [] };
  // The words joined again: PowerShell allows spaces in `[ IO.File ]:: Delete( 'x' )`.
  for (const word of [cmd.words.join(" ")]) {
    for (const call of word.matchAll(CALL)) {
      const args = argumentsAt(word, call.index + call[0].length);
      for (const at of read(call[1] as string)) {
        const text = /^(['"])(.*)\1$/s.exec(args[at] ?? "")?.[2];
        if (text) found.reads.push(text);
      }
      for (const at of written(call[1] as string)) {
        const arg = args[at];
        if (arg === undefined) continue;
        const quoted = /^(['"])(.*)\1$/s.exec(arg);
        const built = quoted ? quoted[1] === '"' && arg.includes("`") : /[(`[]/.test(arg);
        if (/^\$(?:_|PSItem)\b/i.test(arg)) found.piped = true;
        else if (built || arg === "" || (quoted?.[1] !== "'" && holdsVariable(arg)))
          found.unknown = true;
        else found.targets.push(quoted ? (quoted[2] as string) : arg);
      }
    }
    for (const call of word.matchAll(OTHER_CALL)) {
      for (const arg of argumentsAt(word, call.index + call[0].length)) {
        const text = /^(['"])(.*)\1$/s.exec(arg)?.[2];
        if (text) found.reads.push(text);
      }
    }
  }
  return found;
}
