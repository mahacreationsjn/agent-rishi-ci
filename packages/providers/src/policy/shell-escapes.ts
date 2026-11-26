/**
 * How the shell lexer (`./shell`) reads escape characters (§11.2). A POSIX shell removes a
 * backslash before an ordinary character, so `\.\./x` is `../x` and `r\m` is `rm`. PowerShell's
 * escape is the backtick (the lexer reads it by dialect) and cmd's is `^`; to both, a backslash is
 * a path separator. A word is unescaped before any rule resolves it as a path.
 *
 * - `keep`: backslashes stay as written, as PowerShell and cmd read them.
 * - `posix`: a backslash is removed and the character after it kept, and `$'…'` is decoded.
 * - `careful`: for a shell that isn't known, on Windows, where most backslashes are separators. A
 *   word is read the POSIX way only when that changes where it points: it climbs out of a folder
 *   (`\.\.`), or starts at the root or the home folder (`\/x`, `\~/x`). So is the word that names
 *   the program, when that leaves a plain name (`r\m` is `rm`).
 * - `caret`: cmd's `^` is removed and the character after it kept; backslashes stay.
 */
export type EscapeMode = "keep" | "posix" | "careful" | "caret";

/** True when the mode reads `$'…'` and backslashes the POSIX way. */
export const readsPosix = (mode: EscapeMode): boolean => mode === "posix" || mode === "careful";

/** How many `..` segments a word has, with either separator. */
const climbs = (word: string): number => word.split(/[\\/]+/).filter((s) => s === "..").length;

/** True when a word starts at the root or the home folder, as a POSIX shell reads it. */
const anchored = (word: string): boolean => /^[/~]/.test(word);

/** A program's plain name, or its POSIX path (`/usr/bin/rm`). */
const PLAIN_NAME = /^[\w.+/-]+$/;

/**
 * The text of a word that held a backslash escape: `kept` as written, `plain` with the escapes
 * taken out. `names`: the word names the program the command runs.
 */
export function escapedWord(kept: string, plain: string, mode: EscapeMode, names = false): string {
  if (mode === "posix") return plain;
  if (mode !== "careful") return kept;
  if (names && PLAIN_NAME.test(plain)) return plain;
  const moves = climbs(plain) > climbs(kept) || (anchored(plain) && !anchored(kept));
  return moves ? plain : kept;
}

const ANSI_C: Record<string, string> = {
  a: "\x07",
  b: "\b",
  e: "\x1b",
  E: "\x1b",
  f: "\f",
  n: "\n",
  r: "\r",
  t: "\t",
  v: "\v",
};

/** One escape of a `$'…'` string: `\xHH`, `\uHHHH`, `\UHHHHHHHH`, octal `\NNN`, or one character. */
const ANSI_ESCAPE = /\\(x[0-9a-fA-F]{1,2}|u[0-9a-fA-F]{1,4}|U[0-9a-fA-F]{1,8}|[0-7]{1,3}|[\s\S])/g;

/** The text of bash's `$'…'` string (`body`: what is between the quotes), escapes decoded. */
export function decodeAnsiC(body: string): string {
  return body.replace(ANSI_ESCAPE, (_, esc: string) => {
    const head = esc[0] as string;
    if ("xuU".includes(head) && esc.length > 1) return fromCode(Number.parseInt(esc.slice(1), 16));
    if (/^[0-7]+$/.test(esc)) return fromCode(Number.parseInt(esc, 8));
    return ANSI_C[head] ?? esc;
  });
}

function fromCode(code: number): string {
  return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : "";
}
