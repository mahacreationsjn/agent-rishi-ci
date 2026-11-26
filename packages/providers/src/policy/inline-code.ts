/**
 * Paths an interpreter's one-liner may write (§11.2): `python -c`, `node -e`, `perl -e`,
 * `ruby -e`, `php -r`. Agents run such one-liners all the time, so they don't ask by themselves.
 * When the code uses a call that writes or deletes (`os.remove`, `shutil.rmtree`, `open(…, 'w')`,
 * `fs.rm`, `fs.writeFile`, `unlink`, ...), each string literal in it that is an absolute or
 * home-relative path is judged as a write: outside the worktree and the other writable folders
 * it asks, and in Agent Rishi's home it asks at every level.
 *
 * When it runs a command (`os.system`, `subprocess.run`, `execSync`, `system`), its string
 * literals are also read as command lines, and judged like the script of `bash -c`.
 *
 * Every string literal that may be a path, absolute or relative, is also judged as a read of that
 * file (`inlineCodePaths`), the way `cat` reading it is: `open('~/.ssh/id_rsa').read()` asks like
 * `cat ~/.ssh/id_rsa`, and a path in Agent Rishi's home asks at every level.
 *
 * This is a heuristic over the text, not a reading of the code. It doesn't follow a path or a
 * command built at run time (joined from parts, read from a variable, the environment or a file),
 * or a script in a file. A script on standard input (`python - <<EOF`, `echo '…' | node`) is read
 * when it is written out (`./stdin-scripts`). And it can't tell which literal the writing call
 * uses, so a one-liner that reads one absolute path and writes somewhere else asks too.
 */

/** Interpreters and the options their code follows. */
const CODE_FLAGS = new Map<string, RegExp>([
  ["python", /^-[a-zA-Z]*c$/],
  ["node", /^(-e|-p|-pe|--eval|--print)$/],
  ["tsx", /^(-e|--eval)$/],
  ["ts-node", /^(-e|-p|-pe|--eval|--print)$/],
  ["bun", /^(-e|--eval|-p|--print)$/],
  ["deno", /^eval$/],
  ["perl", /^-[a-zA-Z0-9]*[eE]$/],
  ["ruby", /^-[a-zA-Z]*e$/],
  ["php", /^-r$/],
]);

/** The same options with the code written right after them: `python -c"…"`, `perl -le'…'`. */
const ATTACHED = new Map<string, RegExp>([
  ["python", /^-[bBdEhiIOPqsSuvVxR]*c(.+)$/s],
  ["perl", /^-[a-zA-Z0-9]*?[eE](.+)$/s],
  ["ruby", /^-[a-zA-Z]*?e(.+)$/s],
  ["php", /^-r(.+)$/s],
]);

/** `python3`, `python3.12`, `py`, `pypy3`, `nodejs` and the like, by their plain name. */
function interpreter(bin: string): string | undefined {
  if (/^(python|pypy)[\d.]*$|^py$/.test(bin)) return "python";
  if (bin === "nodejs") return "node";
  return CODE_FLAGS.has(bin) ? bin : undefined;
}

/**
 * The code of an interpreter's one-liner (every `-c`/`-e` given, also `--eval=code` and the code
 * written onto its option, `-c"…"`), or none.
 */
export function inlineCode(bin: string, args: string[]): string[] {
  const name = interpreter(bin) ?? "";
  const flag = CODE_FLAGS.get(name);
  if (!flag) return [];
  return args.flatMap((a, i) => {
    const bound = /^(--eval|--print)=(.+)$/s.exec(a);
    if (bound?.[2] && flag.test(bound[1] as string)) return [bound[2]];
    if (flag.test(a)) return args[i + 1] ? [args[i + 1] as string] : [];
    return ATTACHED.get(name)?.exec(a)?.[1] ?? [];
  });
}

/** Calls and operators that write, change or delete files, across the interpreters. */
const WRITES = new RegExp(
  [
    String.raw`\b(remove|removedirs|unlink|rmdir|rmtree|remove_tree|rm_rf|rm_r|truncate)\w*\b`,
    String.raw`\b(mkdir|makedirs|mkdir_p|rename|symlink|chmod|chown)\w*\b`,
    String.raw`\b(writeFile|appendFile|copyFile|copytree|createWriteStream)\w*\b`,
    String.raw`\b(write_text|write_bytes|file_put_contents)\b`,
    String.raw`\.(rm|cp)(Sync)?\s*\(`,
    String.raw`\b(os\.replace|shutil\.(move|copy\w*)|File\.(write|delete|open)|FileUtils\.\w+)\b`,
    String.raw`(?<!stdout|stderr|res|socket)\.(write|touch)\s*\(`,
    String.raw`\bopen\s*\([^)]*,\s*(mode\s*=\s*)?["'][rwax+bt]*[wax+][rwax+bt]*["']`,
    String.raw`\bopen\s*\(?[^;]*["']\s*\+?>`,
  ].join("|"),
  "i",
);

/** A quoted string of path characters, without a line break. */
const LITERAL = /(["'`])((?:\\.|(?!\1)[^\\\n\r])*)\1/g;
/**
 * A path that may lie outside the worktree: absolute or home-relative (`/a`, `/a/b`, `~/x`,
 * `C:\x`, `C:/x`, `\\server\x`), or climbing out of a folder (`../x`). Not `'/'` alone, which is
 * more often a separator.
 */
const ROOTED = /^(?:~[\\/].|[a-zA-Z]:[\\/].|\\\\.|\/[^/\s]|\.\.(?:[\\/]|$))/;
/** Not a path: a URL or a comment marker, a pattern or an HTML tag, text with spaces around it. */
const NOT_A_PATH = /^\/\/|:\/\/|^\/\s|[<>|*?"^$\n]|\s{2}/;
/**
 * Calls whose strings are text, not files: `s.replace('/api/v1', '/api/v2')`, `print('/done')`.
 * They are left out before the literals are read.
 */
const TEXT_CALLS =
  /(?:\.(?:replace(?:All)?|split|join|startsWith|endsWith|startswith|endswith|includes|indexOf|g?sub|strip\w*|trim\w*)|\b(?:print|puts|echo|console\.\w+))\s*\((?:[^()]|\([^()]*\))*\)/g;

/**
 * The paths `code` may write: its rooted string literals, when it uses a writing call. Perl's
 * `open(F, '>/x')` names the file after its mode.
 */
export function inlineCodeWrites(code: string): string[] {
  if (!WRITES.test(code)) return [];
  const out: string[] = [];
  const read = code.replace(TEXT_CALLS, "");
  for (const match of read.matchAll(LITERAL)) {
    const text = unquoted(match[2] as string).replace(/^\+?>>?\s*/, "");
    if (!ROOTED.test(text) || NOT_A_PATH.test(text)) continue;
    // A single name at the root (`'/about'`) is more often a route than a file, unless a call is
    // handed it (`rmtree('/home')`, `unlink "/home"`).
    const handed = /[(\w]\s*$/.test(read.slice(0, match.index));
    if (handed || !/^\/[^/]+\/?$/.test(text)) out.push(text);
  }
  return out;
}

/** A string literal's text, without the escapes of its quotes and separators. */
const unquoted = (body: string): string => body.replace(/\\([\\/"'])/g, "$1");

/**
 * A plain string literal (Python's `r'…'` and `b'…'` too): nothing in it is filled in or run, so
 * no `{` (`f'{…}'`, Ruby's `"#{…}"`) and no line break.
 */
const PLAIN = String.raw`[rbuRBU]{0,2}(?:"(?:\\.|[^"\\\n{])*"|'(?:\\.|[^'\\\n{])*')`;
/**
 * Calls that only test or print text and are handed nothing but plain literals (`print('/x')`,
 * `f.endswith(('.pem', '.key'))`, `console.log('/x')`): their strings are left out of the paths a
 * one-liner reads. A call handed anything else (`print(open('/x').read())`, `print(p := '/x')`)
 * stays.
 */
const TEST_OR_PRINT = new RegExp(
  // Each space is matched one way only, so text that doesn't match fails fast.
  String.raw`(?:\.(?:startsWith|endsWith|startswith|endswith|includes|indexOf)|\b(?:print|puts|console\.\w+))\s*\(\s*(?:[([]\s*)?(?:${PLAIN}\s*(?:,\s*)?)*(?:[)\]]\s*)?\)`,
  "g",
);
/** Not a file: a URL, or text with a line break, a pipe or a quote in it. */
const NOT_A_FILE = /^[a-z][\w+.-]*:\/\/|[\n\r|"<>]/i;

/**
 * The files `code` may read: each string literal that may be a path, absolute or relative, its
 * open mode taken off (perl's `open(F, '</x')`), also inside code in a string
 * (`exec("open('/x')")`). The risk classifier judges each like a file `cat` reads
 * (`classifyRead`), so a literal naming a secrets file or Agent Rishi's home asks however the code
 * opens it (`open`, `readFileSync`, `File.read`, `file_get_contents`).
 */
export function inlineCodePaths(code: string, depth = 0): string[] {
  const out: string[] = [];
  for (const text of literals(code.replace(TEST_OR_PRINT, ""))) {
    if (depth < 2 && /["'`]/.test(text)) out.push(...inlineCodePaths(text, depth + 1));
    const path = text.replace(/^\+?(?:<|>>?)\s*/, "").trim();
    if (path && !NOT_A_FILE.test(path)) out.push(path);
  }
  return out;
}

/** The text of each string literal in `code`, in order. */
const literals = (code: string): string[] =>
  [...code.matchAll(LITERAL)].map((m) => unquoted(m[2] as string));

/**
 * Calls that run a command: `os.system`, `subprocess.run`, `execSync`, `spawn`, `system`, PHP's
 * `shell_exec` and `proc_open`, Ruby's `Open3`.
 */
const RUNS =
  /\b(system|popen\w*|exec\w*|spawn\w*|subprocess|check_call|check_output|passthru|shell_exec|proc_open|Open3)\b/i;
/** A word a shell reads as it is written. */
const PLAIN_WORD = /^[\w@%+=:,./\\~-]+$/;
/** More literals than this are read one by one only. */
const MAX_WORDS = 24;
/** The closing mark of Perl's `qx(…)` and Ruby's `%x(…)`, by the opening one. */
const CLOSERS: Record<string, string> = { "(": ")", "{": "}", "[": "]", "<": ">" };

/**
 * The command lines Perl, Ruby and PHP run without a call: in backticks, `qx(…)` and `%x(…)`, and
 * a pipe that Perl's or Ruby's `open` starts (`open(F, "cat x |")`, `open("|cat x")`).
 */
function quotedCommands(code: string, bin: string): string[] {
  const name = interpreter(bin) ?? "";
  if (name !== "perl" && name !== "ruby" && name !== "php") return [];
  const out = [...code.matchAll(/`((?:\\.|[^`\\])*)`/g)].map((m) => m[1] as string);
  for (const m of code.matchAll(/(?:\bqx|%x)\s*([^\w\s])/g)) {
    const from = m.index + m[0].length;
    const end = code.indexOf(CLOSERS[m[1] as string] ?? (m[1] as string), from);
    if (end > from) out.push(code.slice(from, end));
  }
  if (name === "php") return out;
  const pipes = literals(code).flatMap((t) => /^\s*\|(.+)$|^(.+)\|\s*$/s.exec(t)?.slice(1) ?? []);
  return [...out, ...pipes.filter((t): t is string => t !== undefined)];
}

/**
 * The command lines `code` (run by `bin`) may run: those Perl, Ruby and PHP run in backticks and
 * the like (`quotedCommands`); and when it uses a call that runs one, each string literal with a
 * space in it (`os.system('rm -rf x')`), and each run of literals from a program's name on, as
 * the words of one command (`subprocess.run(['rm', '-rf', 'x'])`, `execFileSync('rm', ['x'])`).
 */
export function inlineCodeCommands(code: string, bin = ""): string[] {
  const quoted = quotedCommands(code, bin);
  if (!RUNS.test(code)) return quoted;
  const found = literals(code);
  const out = [...quoted, ...found.filter((text) => /\S\s+\S/.test(text))];
  if (found.length > MAX_WORDS) return out;
  const words = found.map((w) => (PLAIN_WORD.test(w) ? w : `'${w.replace(/'/g, "")}'`));
  for (const [i, word] of found.entries()) {
    if (i < found.length - 1 && PLAIN_WORD.test(word)) out.push(words.slice(i).join(" "));
  }
  return out;
}
