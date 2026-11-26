import { DATA } from "./secrets";

/**
 * Environment dumps (§11.2, #447): commands that print the values of every variable, or of a
 * set of them a prefix or wildcard picks. They ask at Auto as secrets access. Printing a named
 * variable that doesn't look like a credential (`printenv PATH`, `Get-ChildItem env:NODE_ENV`)
 * is not a dump. `./env-names` lets a listing through when only the names reach the agent.
 */

/** Variable names that may hold a credential. */
const SECRET_VAR = /key|token|secret|passw|pwd|credential|auth|private|session|cookie/i;

/** PowerShell commands that list the `env:` drive. */
export const ENV_DRIVE = /^(get-childitem|gci|ls|dir)$/;

/** POSIX shells' builtins that print variables with their values (`export -p`, `declare -x`). */
const DECLARES = new Set(["export", "declare", "typeset"]);

/** JavaScript runtimes and Python interpreters, whose inline code may print the environment. */
const JS_RUNTIMES = new Set(["node", "nodejs", "bun", "deno", "tsx"]);
const PYTHONS = /^(python[\d.]*|py|pypy[\d.]*)$/;

/**
 * `process.env` (or `Bun.env`) used whole, and `Deno.env.toObject()`. Not whole: one variable
 * (`process.env.NAME`, `process.env["NAME"]`), its names (`Object.keys(process.env)`) or a
 * membership test (`"NAME" in process.env`).
 */
const JS_ENV =
  /(?<!\bin\s+|Object\.keys\(\s*)\b(?:process|Bun)\.env\b(?!\s*(?:\??\.\s*[A-Za-z_$]|\[\s*(["'`])\w*\1\s*\]))|\bDeno\.env\.toObject\b/;

/** `os.environ` (or `os.environb`) in Python code. */
const PY_ENVIRON = /\bos\.environb?\b/g;
/**
 * What may follow `os.environ` without printing every value: one variable by a literal name
 * (`["NAME"]`, `.get("NAME")`) or the names (`.keys()`).
 */
const PY_ONE_OR_NAMES = /^\s*(?:\[\s*(["'])\w*\1\s*\]|\.get\s*\(\s*(["'])\w*\2|\.keys\s*\()/;
/** `os.getenv(…)` with a name that isn't a literal: `os.getenv(k)` in a loop over the names. */
const PY_GETENV_ANY = /\bos\.getenvb?\s*\(\s*(?!["')])/;

/**
 * True when Python code uses `os.environ` whole (`print(os.environ)`, `dict(os.environ)`,
 * `for k, v in os.environ.items()`) or looks a variable up by a name that isn't a literal
 * (`os.environ[k]`, `os.environ.get(k)`, `os.getenv(k)`). Not whole: one variable by name, the
 * names (`os.environ.keys()`), a membership test (`"NAME" in os.environ`) and a loop over the
 * names (`for k in os.environ:`).
 */
function pythonDumps(code: string): boolean {
  if (PY_GETENV_ANY.test(code)) return true;
  for (const match of code.matchAll(PY_ENVIRON)) {
    const before = code.slice(0, match.index);
    const after = code.slice(match.index + match[0].length);
    if (PY_ONE_OR_NAMES.test(after)) continue;
    // `in os.environ` on its own tests or iterates names; `in os.environ.items()` doesn't.
    if (/\bin\s+$/.test(before) && !/^\s*[.[]/.test(after)) continue;
    return true;
  }
  return false;
}

/** .NET's `[Environment]::GetEnvironmentVariables()`, as a statement or a value assigned. */
const DOTNET_ENV =
  /^(?:\$[\w:]+\s*=\s*)?\(?\[(?:system\.)?environment\]::getenvironmentvariables\b/i;

/** Names given that don't look like credentials, so printing them is not a dump. */
const named = (names: string[]) =>
  names.length > 0 && names.every((n) => /^\w+$/.test(n) && !SECRET_VAR.test(n));

/**
 * True for commands that print the environment's values: `printenv`, bare `env`, `set`,
 * `export -p` and `declare -x`, `Get-ChildItem env:`, `[Environment]::GetEnvironmentVariables()`
 * and inline code that prints `process.env` or `os.environ` whole. `bin` is the command's
 * program (`binName`), `args` the words after it.
 */
export function dumpsEnvironment(bin: string, args: string[]): boolean {
  if (listsEnvironment(bin, args)) return true;
  if (!DATA.has(bin) && [bin, ...args].some((w) => DOTNET_ENV.test(w))) return true;
  if (JS_RUNTIMES.has(bin)) return args.some((a) => JS_ENV.test(a));
  if (PYTHONS.test(bin)) return args.some(pythonDumps);
  return false;
}

/**
 * The dumps that list entries, one variable per line or item (`NAME=value`, PowerShell's
 * name/value items): what `./env-names` follows down a pipeline to see whether only the names
 * are kept.
 */
export function listsEnvironment(bin: string, args: string[]): boolean {
  if (bin === "printenv") return !named(args.filter((a) => !a.startsWith("-")));
  if (bin === "env") return envPrints(args);
  if (bin === "set") return setPrints(args);
  if (DECLARES.has(bin)) return declarePrints(bin, args);
  if (!ENV_DRIVE.test(bin)) return false;
  const drives = args.filter((a) => /^env:/i.test(a));
  return drives.length > 0 && !named(drives.map((a) => a.slice(4)));
}

/**
 * `env` with no command to run (`unwrap` keeps it as the program then) prints the environment,
 * unless it starts from an empty one (`env -i`, `env -`).
 */
function envPrints(args: string[]): boolean {
  return !args.some((a) => a === "-" || a === "--ignore-environment" || /^-[0v]*i/.test(a));
}

/**
 * Bare `set` prints every variable, in POSIX shells and cmd, and cmd's `set NAME` prints every
 * variable whose name starts with NAME. Options (`set -e`, `set -- a b`, `set +x`), cmd's
 * switches (`set /a`, `set /p`) and assignments (`set NAME=`) print none.
 */
function setPrints(args: string[]): boolean {
  const first = args[0];
  return first === undefined || !(/^[-+/]/.test(first) || first.includes("="));
}

/**
 * `export`, `declare` and `typeset` with no names print the variables with their values
 * (`export -p`, `declare -x`), except functions (`-f`, `-F`). With names they set or export
 * them, and `declare -p NAME` prints those named.
 */
function declarePrints(bin: string, args: string[]): boolean {
  const flags = args.filter((a) => /^[-+]/.test(a)).join("");
  const operands = args.filter((a) => !/^[-+]/.test(a));
  if (/f/i.test(flags)) return false;
  if (operands.length === 0) return true;
  return bin !== "export" && flags.includes("p") && !named(operands);
}
