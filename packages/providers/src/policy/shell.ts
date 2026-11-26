import { assignsAt, itemsIn, variableItem } from "./ps-variables";
import {
  Builder,
  type PendingHeredoc,
  type ShellDialect,
  type SimpleCommand,
} from "./shell-builder";
import { decodeAnsiC, type EscapeMode, readsPosix } from "./shell-escapes";

/**
 * A small shell lexer for the risk classifier (§11.2). It splits a command line into simple
 * commands the way a shell would, so quoted text, heredoc bodies and PowerShell here-strings
 * stay data instead of being read as commands, and output redirections are only found
 * outside quotes. A heredoc's body is kept with the command that reads it, and the substitutions
 * an unquoted one runs (`$(…)`, backticks) are read as that command's. It covers POSIX shells and PowerShell well enough to classify commands;
 * it is not a full parser. The command being built is `./shell-builder`'s; how escapes are read,
 * `./shell-escapes`'.
 */

export type { ShellDialect, SimpleCommand, WordPaths } from "./shell-builder";
export { wordPaths } from "./shell-builder";

/**
 * Parse a command line into its simple commands. `escapes`: how backslashes and carets are read
 * (`./shell-escapes`); `./shell-readings` gives the ways a command line may be read.
 */
export function parseShell(
  src: string,
  dialect: ShellDialect = "auto",
  escapes: EscapeMode = "keep",
): SimpleCommand[] {
  return new Lexer(src, dialect, escapes).list(null);
}

/** Placeholder for heredoc and here-string bodies, which are data, never commands. */
const BODY = "<body>";

/**
 * When the shell is unknown, a `${…}` that may be a PowerShell drive item: up to the first `}`,
 * with no `$`, backtick or line break in its name (bash's `${x:-$(cmd)}` runs a command instead).
 */
const BRACED_NAME = /\$\{([^}`$\n\r]*)\}/y;

type Closer = ")" | "`" | "}";

class Lexer {
  private i = 0;
  /** Where the block being read again as plain words ends (`block`). */
  private blockEnd = 0;
  /** True when the list just read ran to the end of the input without its closer. */
  private open = false;

  constructor(
    private readonly src: string,
    private readonly dialect: ShellDialect,
    private readonly escapes: EscapeMode,
  ) {}

  /** Read simple commands until `closer` (`)`, `}` or a backtick) or the end of the input. */
  list(closer: Closer | null): SimpleCommand[] {
    const out: SimpleCommand[] = [];
    const b = new Builder(out, this.dialect, this.escapes);
    const { src } = this;
    while (this.i < src.length) {
      const c = src[this.i] as string;
      const next = src[this.i + 1];
      // A `}` inside a block being read again as words is one of its inner blocks'.
      if (closer && c === closer && !(c === "}" && this.i < this.blockEnd)) {
        this.i += 1;
        b.endCommand();
        this.open = false;
        return out;
      }
      if (c === "\n" || c === "\r") {
        b.endCommand();
        this.i += c === "\r" && next === "\n" ? 2 : 1;
        this.skipHeredocs(b.heredocs.splice(0));
      } else if (c === " " || c === "\t") {
        b.endWord();
        this.i += 1;
      } else if (c === "#" && !b.inWord) {
        while (this.i < src.length && src[this.i] !== "\n" && src[this.i] !== "\r") this.i += 1;
      } else if (c === ";") {
        b.endCommand();
        this.i += 1;
      } else if (c === "|") {
        b.endCommand();
        // `||` runs the next command on failure; `|` and `|&` pipe into it.
        if (next !== "|") b.cmd.piped = true;
        this.i += next === "|" || next === "&" ? 2 : 1;
      } else if (c === "&" && next === ">") {
        b.endWord();
        b.target = "write";
        this.i += src[this.i + 2] === ">" ? 3 : 2;
      } else if (c === "&") {
        b.endCommand();
        this.i += next === "&" ? 2 : 1;
      } else if (c === ">" || c === "<") {
        this.redirect(b, c);
      } else if (c === "$" && next === "'" && this.ansiC()) {
        // Bash's `$'…'`: a string with C escapes (`$'\x2e\x2e'` is `..`).
        b.add(decodeAnsiC(this.readAnsi()));
      } else if (c === "'" || c === '"') {
        b.quotes();
        if (b.inWord && b.word.endsWith("@") && this.lineEndsAt(this.i + 1)) {
          const body = this.skipHereString(c);
          // `@"…"@` expands its variables; `@'…'@` doesn't.
          if (c === '"' && this.dialect !== "posix") {
            for (const item of itemsIn(body, this.dialect === "auto")) b.read(item);
          }
          b.add(BODY);
        } else if (c === "'") {
          b.add(this.readSingle());
        } else {
          b.add(this.readDouble(b));
        }
      } else if (c === "\\" && this.dialect !== "powershell" && this.escapes !== "caret") {
        // POSIX escape: the next character is literal (a newline continues the line). Whether the
        // backslash stays (a Windows path's separator) is `./shell-escapes`'.
        if (next === "\n" || next === "\r") {
          this.i += next === "\r" && src[this.i + 2] === "\n" ? 3 : 2;
        } else {
          if (next !== undefined) b.addEscaped(next);
          else b.add(c);
          this.i += 2;
        }
      } else if (c === "^" && this.escapes === "caret" && next !== undefined) {
        // cmd's escape: the next character is literal (`^&` is no separator).
        if (next !== "\n" && next !== "\r") b.add(next);
        this.i += 2;
      } else if (c === "`") {
        this.backtick(b);
      } else if (c === "(") {
        const start = this.i;
        this.i += 1;
        b.cmd.nested.push(this.list(")"));
        const group = src.slice(start, this.i);
        if (this.dialect !== "posix" && group.includes("$")) b.expands();
        b.add(group);
      } else if (c === "," && this.dialect !== "posix") {
        // PowerShell passes `a,b` as a list of two paths; a POSIX shell, as one name.
        b.addComma();
        this.i += 1;
      } else if (c === "$" && next === "{" && this.dialect !== "posix") {
        b.add(this.braced(b, false));
      } else {
        if (c === "{") this.block(b);
        if (c === "$") b.expands();
        b.add(c);
        this.i += 1;
      }
    }
    b.endCommand();
    this.open = closer !== null;
    return out;
  }

  /**
   * A `{` outside POSIX shells: a PowerShell script block, or a group or function body of a shell
   * that isn't known. Its commands are read as a list of their own (`blocks`); then the lexer goes
   * back and reads it as plain words, as before, so the rules that read a block as an argument
   * still see its words. Not `${name}`, and not a block inside one being read again.
   */
  private block(b: Builder): void {
    const start = this.i;
    if (this.dialect === "posix" || start < this.blockEnd || this.src[start - 1] === "$") return;
    this.i += 1;
    const commands = this.list("}");
    b.cmd.blocks = [...(b.cmd.blocks ?? []), commands];
    if (this.open) b.cmd.unparsed = true;
    this.blockEnd = this.i;
    this.i = start;
  }

  /** True when `$'…'` is bash's string with C escapes: read the POSIX way, outside PowerShell. */
  private ansiC(): boolean {
    return this.dialect !== "powershell" && readsPosix(this.escapes);
  }

  /** The body of the `$'…'` at `this.i`: to the first `'` no backslash escapes. */
  private readAnsi(): string {
    const { src } = this;
    let j = this.i + 2;
    while (j < src.length && src[j] !== "'") j += src[j] === "\\" ? 2 : 1;
    const body = src.slice(this.i + 2, Math.min(j, src.length));
    this.i = Math.min(j + 1, src.length);
    return body;
  }

  /** `>`, `>>`, `>|`, `2>`, `*>`, `2>&1`, `<`, `<<EOF`, `<<-EOF`, `<<<`, `<(…)`, `>(…)`. */
  private redirect(b: Builder, c: ">" | "<"): void {
    const { src } = this;
    // A file descriptor written right before the operator (`2>`, `*>`) is not a word.
    if (b.inWord && /^(\d+|\*)$/.test(b.word)) b.dropWord();
    else b.endWord();
    const next = src[this.i + 1];
    if (next === "(") {
      const start = this.i;
      this.i += 2;
      b.cmd.nested.push(this.list(")"));
      b.add(src.slice(start, this.i));
      return;
    }
    if (c === "<") {
      if (next === "<" && src[this.i + 2] === "<") {
        b.target = "skip";
        this.i += 3;
      } else if (next === "<") {
        this.i += 2;
        b.heredocStrip = src[this.i] === "-";
        if (b.heredocStrip) this.i += 1;
        b.heredocQuoted = /^[ \t]*[^\s'"\\]*['"\\]/.test(src.slice(this.i, this.i + 80));
        b.target = "heredoc";
      } else {
        // Input redirect: the file stays an argument, so secrets checks still see it.
        this.i += 1;
      }
      return;
    }
    let j = this.i + 1;
    if (src[j] === ">") j += 1;
    if (src[j] === "|") j += 1;
    if (src[j] === "&") {
      const dup = /^&(\d+|-)/.exec(src.slice(j));
      if (dup) {
        this.i = j + dup[0].length;
        return;
      }
      j += 1;
    }
    b.target = "write";
    this.i = j;
  }

  /**
   * PowerShell escapes the next character; POSIX starts a command substitution. (A closing
   * backtick never gets here: `list` checks for its closer first.)
   */
  private backtick(b: Builder): void {
    const { src } = this;
    const next = src[this.i + 1];
    const escapes =
      this.dialect === "powershell" ||
      (this.dialect === "auto" && (next === undefined || /\s/.test(next)));
    if (escapes) {
      if (next === "\n" || next === "\r") {
        this.i += next === "\r" && src[this.i + 2] === "\n" ? 3 : 2;
      } else {
        b.add(src.slice(this.i + 1, this.i + 2));
        this.i += 2;
      }
      return;
    }
    const start = this.i;
    this.i += 1;
    b.cmd.nested.push(this.list("`"));
    b.expands();
    b.add(src.slice(start, this.i));
  }

  /** A single-quoted string. PowerShell writes a quote in one twice: `'it''s'` is `it's`. */
  private readSingle(): string {
    const body = this.dialect === "powershell" ? /'((?:[^']|'')*)('?)/y : /'([^']*)('?)/y;
    body.lastIndex = this.i;
    const [, text = "", closed] = body.exec(this.src) ?? [];
    this.i = body.lastIndex + (closed ? 0 : 1);
    return text.replace(/''/g, "'");
  }

  /** A double-quoted string: escapes, and `$(…)` substitutions run as nested commands. */
  private readDouble(b: Builder): string {
    const { src } = this;
    let text = "";
    this.i += 1;
    while (this.i < src.length) {
      const c = src[this.i] as string;
      const next = src[this.i + 1];
      if (c === '"') {
        this.i += 1;
        return text;
      }
      if (c === "\\" && this.dialect !== "powershell" && next && '"\\$`\n'.includes(next)) {
        // Read as written (PowerShell, cmd), `\\` stays: `"\\?\C:\x"` is a device path there.
        text += next === "\\" && this.escapes === "keep" ? "\\\\" : next;
        this.i += 2;
      } else if (c === "`" && this.dialect !== "posix" && next !== undefined) {
        text += next;
        this.i += 2;
      } else if (c === "`") {
        const start = this.i;
        this.i += 1;
        b.cmd.nested.push(this.list("`"));
        b.expands();
        text += src.slice(start, this.i);
      } else if (c === "$" && next === "(") {
        const start = this.i;
        this.i += 2;
        b.cmd.nested.push(this.list(")"));
        b.expands();
        text += src.slice(start, this.i);
      } else if (c === "$" && next === "{" && this.dialect !== "posix") {
        text += this.braced(b, true);
      } else {
        if (c === "$") b.expands();
        text += c;
        this.i += 1;
      }
    }
    return text;
  }

  /**
   * `${…}` at `this.i`. In PowerShell it is one variable, read whole: the name may hold spaces and
   * ends at the first `}` a backtick doesn't escape. When the shell is unknown (`auto`) it may be
   * bash's `${x:-$(cmd)}`, whose `$(…)` and backticks run commands, so only the `$` is taken here
   * and the rest is lexed as usual; the item it names is found by looking ahead. The text taken.
   */
  private braced(b: Builder, quoted: boolean): string {
    const { src } = this;
    const start = this.i;
    b.expands();
    if (this.dialect !== "powershell") {
      BRACED_NAME.lastIndex = start;
      const m = BRACED_NAME.exec(src);
      if (m) this.noteItem(b, variableItem(m[1] as string, true), quoted, start + m[0].length);
      this.i += 1;
      return "$";
    }
    let j = start + 2;
    while (j < src.length && src[j] !== "}") j += src[j] === "`" ? 2 : 1;
    this.i = Math.min(j + 1, src.length);
    this.noteItem(b, variableItem(src.slice(start + 2, Math.min(j, src.length))), quoted, this.i);
    return src.slice(start, this.i);
  }

  /**
   * Note the item a PowerShell variable on a drive names (`${C:\x}`, `./ps-variables`): written
   * when an assignment operator follows it (at `after`), and read unless it is only the target of
   * an assignment that starts the command (`${C:\x} = …`, `[string]${C:\x} = …`). `quoted`: inside
   * a double-quoted string, where it is always read.
   */
  private noteItem(b: Builder, item: string | undefined, quoted: boolean, after: number): void {
    if (item === undefined) return;
    const assigns = !quoted && assignsAt(this.src, after);
    const target = assigns && !b.cmd.words.length && /^(?:\[[^\]]*\])*$/.test(b.word);
    if (assigns) b.cmd.writes.push(item);
    if (!target) b.read(item);
  }

  /** True when only spaces or tabs remain before the end of the line at `j`. */
  private lineEndsAt(j: number): boolean {
    const rest = /^[ \t]*(\r?\n|$)/.exec(this.src.slice(j));
    return rest !== null;
  }

  /** Skip a PowerShell here-string (`@'` … `'@`) whose opening quote is at `this.i`; its body. */
  private skipHereString(quote: "'" | '"'): string {
    const close = new RegExp(`(^|\\n)${quote}@`, "g");
    const from = this.i + 1;
    close.lastIndex = from;
    const m = close.exec(this.src);
    this.i = m ? m.index + m[0].length : this.src.length;
    return this.src.slice(from, m ? m.index : this.src.length);
  }

  /**
   * Skip the bodies of heredocs opened on the line that just ended. Each is kept with the command
   * that reads it; the substitutions an unquoted one runs are that command's.
   */
  private skipHeredocs(pending: PendingHeredoc[]): void {
    const { src } = this;
    for (const { delim, strip, quoted, owner } of pending) {
      const lines: string[] = [];
      while (this.i < src.length) {
        const nl = src.indexOf("\n", this.i);
        const end = nl === -1 ? src.length : nl;
        let line = src.slice(this.i, end).replace(/\r$/, "");
        if (strip) line = line.replace(/^\t+/, "");
        this.i = nl === -1 ? src.length : nl + 1;
        if (line === delim) break;
        lines.push(line);
      }
      const body = lines.join("\n");
      owner.heredocs = [...(owner.heredocs ?? []), { body, quoted }];
      if (!quoted) owner.nested.push(...new Lexer(body, this.dialect, this.escapes).ran());
    }
  }

  /** The command lists the substitutions of an unquoted heredoc body run: `$(…)` and backticks. */
  ran(): SimpleCommand[][] {
    const { src } = this;
    const out: SimpleCommand[][] = [];
    while (this.i < src.length) {
      const c = src[this.i];
      const open = c === "$" && src[this.i + 1] === "(" ? ")" : c === "`" ? "`" : undefined;
      this.i += open === ")" || c === "\\" ? 2 : 1;
      if (open) out.push(this.list(open));
    }
    return out;
  }
}
