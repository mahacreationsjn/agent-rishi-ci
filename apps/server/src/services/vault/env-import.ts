import {
  VAULT_VALUE_MAX,
  VAULT_VALUE_MIN,
  VaultEnvName,
  type VaultImportSkip,
} from "@agent-rishi/contracts";

/** One `NAME=value` read from a `.env` file. */
export interface EnvEntry {
  line: number;
  name: string;
  value: string;
}

/**
 * The entries of a `.env` file, and the lines that were left out with why (never their value).
 * Reads `NAME=value`, `export NAME=value`, single quotes (literal) and double quotes (`\n`,
 * `\"` and `\\` escapes), and drops a ` # comment` after an unquoted value. A value that runs
 * past its line, or is too short or long for the Vault, is left out; so is a name given twice
 * after its first.
 */
export function parseEnvText(text: string): { entries: EnvEntry[]; skipped: VaultImportSkip[] } {
  const entries: EnvEntry[] = [];
  const skipped: VaultImportSkip[] = [];
  const seen = new Map<string, number>();
  text.split(/\r?\n/).forEach((raw, index) => {
    const line = index + 1;
    const trimmed = raw.trim();
    if (!trimmed || trimmed.startsWith("#")) return;
    const match = /^(?:export\s+)?([^=\s]+)\s*=\s*(.*)$/.exec(trimmed);
    if (!match) {
      skipped.push({ line, name: null, reason: "Not a NAME=value line" });
      return;
    }
    const [, name = "", rest = ""] = match;
    if (!VaultEnvName.safeParse(name).success) {
      skipped.push({ line, name: null, reason: "Not a valid variable name" });
      return;
    }
    const value = readValue(rest);
    if (value === null) {
      skipped.push({ line, name, reason: "Its value runs past the line; add it by hand" });
      return;
    }
    if (value.length < VAULT_VALUE_MIN) {
      skipped.push({
        line,
        name,
        reason: `Shorter than ${VAULT_VALUE_MIN} characters, too short to hide in transcripts`,
      });
      return;
    }
    if (value.length > VAULT_VALUE_MAX) {
      skipped.push({ line, name, reason: `Longer than ${VAULT_VALUE_MAX} characters` });
      return;
    }
    const first = seen.get(name);
    if (first !== undefined) {
      skipped.push({ line, name, reason: `Already set on line ${first}` });
      return;
    }
    seen.set(name, line);
    entries.push({ line, name, value });
  });
  return { entries, skipped };
}

/** The value after `=`, or null when a quote isn't closed on this line. */
function readValue(rest: string): string | null {
  if (rest.startsWith("'")) {
    const end = rest.indexOf("'", 1);
    return end === -1 ? null : rest.slice(1, end);
  }
  if (rest.startsWith('"')) {
    let out = "";
    for (let i = 1; i < rest.length; i++) {
      const c = rest[i];
      if (c === '"') return out;
      if (c === "\\" && i + 1 < rest.length) {
        const next = rest[++i];
        out += next === "n" ? "\n" : next === "t" ? "\t" : (next ?? "");
      } else {
        out += c;
      }
    }
    return null;
  }
  const comment = rest.search(/\s#/);
  return (comment === -1 ? rest : rest.slice(0, comment)).trim();
}
