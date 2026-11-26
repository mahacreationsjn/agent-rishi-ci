import { type RiskAssessment, risky } from "./assessment";

/**
 * Changes to the Windows registry and to the environment that later processes start with (#533).
 * Neither is ever in the worktree, so at Auto they ask like a write outside it (§11.2):
 * - `reg` with any verb but `query`, `compare`, `export` and `save`, which only read the
 *   registry: `add`, `delete`, `import`, `copy`, `restore`, `load`, `unload`, `flags`;
 * - `regedit file.reg` and `regedit /s file.reg`, which import a file;
 * - `setx NAME value` (`/M` for the whole machine), which keeps the variable in the registry;
 * - `[Environment]::SetEnvironmentVariable(name, value, 'User' | 'Machine')`. The `Process`
 *   target, the default, only changes the running shell, so it runs freely;
 * - a `[Microsoft.Win32.Registry]` call that writes (`SetValue`, `CreateSubKey`, `DeleteSubKey`,
 *   `DeleteSubKeyTree`, `DeleteValue`) in the same statement.
 * `reg export`, `reg save` and `regedit /e` write a file, which `registryExports` names so it is
 * judged like any other write. PowerShell's item cmdlets on a registry drive
 * (`Set-ItemProperty HKCU:\…`) are judged by the paths they write (`./item-writes`).
 */

/** A `reg`, `regedit` or `setx` switch: `/f`, `/reg:64`, `/?`, or Git Bash's `//f`. */
const SWITCH = /^(?:\/\/?|-)[a-z?]+(?::\S*)?$/i;
/** `reg` verbs that leave the registry as it is. */
const REG_READS = new Set(["query", "compare", "export", "save"]);
const REGEDIT = new Set(["regedit", "regedt32"]);
/** `regedit`'s export switch. */
const EXPORT = /^(?:\/\/?|-)e$/i;
/** `setx` switches that take the next word as their value. */
const SETX_VALUED = new Set(["s", "u", "p", "k", "f", "a", "r", "d"]);

const SET_ENV = /\[(?:system\.)?environment\]::setenvironmentvariable\s*\(/i;
/** The `Process` target: `'Process'`, `[EnvironmentVariableTarget]::Process` or `0`. */
const PROCESS = /^(?:(?:\[(?:system\.)?environmentvariabletarget\]::)?process|0)$/i;
const REGISTRY_WRITE =
  /\[(?:microsoft\.win32\.)?registry(?:key)?\]::.*?\b(?:setvalue|createsubkey|deletesubkey|deletesubkeytree|deletevalue)\s*\(/i;

const ask = (reason: string): RiskAssessment => risky("outside_worktree", reason);

/** The words of a `reg` or `regedit` command that aren't switches: keys and files. */
const operands = (args: string[]): string[] => args.filter((a) => !SWITCH.test(a));

/**
 * The verdict on a command that changes the registry or the lasting environment, or undefined.
 * `words`: the whole command, for the .NET calls PowerShell makes in an expression. Only a word
 * that starts with a type (`[Environment]::…`, `[void][…]`) is read as one, so a call mentioned
 * inside text (`gh pr create --body "Uses [Environment]::SetEnvironmentVariable(…)"`) is not.
 * Quotes are gone from the words by then, so quoted text that starts with such a call is read as
 * one and asks; that errs on the side of asking.
 */
export function registryChange(
  bin: string,
  args: string[],
  words: string[],
): RiskAssessment | undefined {
  if (bin === "reg") return regChange(args);
  if (REGEDIT.has(bin)) return regeditImport(args);
  if (bin === "setx") return setx(args);
  for (const word of words) {
    if (!word.startsWith("[")) continue;
    if (REGISTRY_WRITE.test(word)) return ask("Writes to the registry");
    const change = environmentChange(word);
    if (change) return change;
  }
  return undefined;
}

/** The files `reg export`, `reg save` and `regedit /e` write. */
export function registryExports(bin: string, args: string[]): string[] {
  let file: string | undefined;
  if (bin === "reg" && ["export", "save"].includes(args[0]?.toLowerCase() ?? "")) {
    file = operands(args.slice(1))[1];
  } else if (REGEDIT.has(bin) && args.some((a) => EXPORT.test(a))) {
    file = operands(args)[0];
  }
  return file ? [file] : [];
}

function regChange(args: string[]): RiskAssessment | undefined {
  const verb = args[0]?.toLowerCase();
  if (!verb || SWITCH.test(verb) || REG_READS.has(verb)) return undefined;
  const [first, second] = operands(args.slice(1));
  if (verb === "delete") {
    return ask(first ? `Deletes ${first} from the registry` : "Deletes registry keys");
  }
  if (verb === "import") {
    return ask(first ? `Imports ${first} into the registry` : "Imports a file into the registry");
  }
  const key = verb === "copy" ? second : first;
  return ask(key ? `Writes ${key} to the registry` : "Writes to the registry");
}

/** `regedit file.reg` imports the file; `regedit /e` exports, and `regedit` alone opens the editor. */
function regeditImport(args: string[]): RiskAssessment | undefined {
  if (args.some((a) => EXPORT.test(a))) return undefined;
  const file = operands(args)[0];
  return file ? ask(`Imports ${file} into the registry`) : undefined;
}

/** `setx NAME value`, `setx NAME /k key`, `setx /f file …`; `setx /?` only prints help. */
function setx(args: string[]): RiskAssessment | undefined {
  let name: string | undefined;
  let sets = false;
  let machine = false;
  for (let i = 0; i < args.length; i += 1) {
    const flag = /^(?:\/\/?|-)([a-z?])$/i.exec(args[i] as string)?.[1]?.toLowerCase();
    if (flag === undefined) {
      name ??= args[i];
      sets = true;
    } else if (flag === "m") {
      machine = true;
    } else if (SETX_VALUED.has(flag)) {
      sets = true;
      i += 1;
    }
  }
  return sets ? ask(lasting(name, machine ? "system" : "user")) : undefined;
}

/** `[Environment]::SetEnvironmentVariable(name, value, target)` with a target other than `Process`. */
function environmentChange(code: string): RiskAssessment | undefined {
  const call = SET_ENV.exec(code);
  if (!call) return undefined;
  const [name, , target] = callArguments(code.slice(call.index + call[0].length)).map(unquote);
  if (target === undefined || PROCESS.test(target)) return undefined;
  const scope = /machine|^2$/i.test(target) ? "system" : /user|^1$/i.test(target) ? "user" : "";
  return ask(lasting(name, scope));
}

function lasting(name: string | undefined, scope: "system" | "user" | ""): string {
  const where =
    scope === "system" ? " for the whole system" : scope === "user" ? " for the user" : "";
  return `Sets ${name ? `the environment variable ${name}` : "an environment variable"} for good${where}`;
}

/** The arguments of a call, read from just after its `(` up to its `)`: split at top-level commas. */
function callArguments(text: string): string[] {
  const out: string[] = [];
  let current = "";
  let depth = 0;
  let quote = "";
  for (const ch of text) {
    if (quote) {
      if (ch === quote) quote = "";
    } else if (ch === "'" || ch === '"') {
      quote = ch;
    } else if (ch === "(" || ch === "[") {
      depth += 1;
    } else if (ch === ")" || ch === "]") {
      if (depth === 0 && ch === ")") break;
      depth = Math.max(0, depth - 1);
    } else if (ch === "," && depth === 0) {
      out.push(current.trim());
      current = "";
      continue;
    }
    current += ch;
  }
  if (current.trim() || out.length > 0) out.push(current.trim());
  return out;
}

const unquote = (s: string): string => s.replace(/^(['"])(.*)\1$/s, "$2");
