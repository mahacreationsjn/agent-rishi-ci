import { isLoginFileName } from "./login-names";

/** Files that commonly hold credentials, by name (§11.2). */

const SECRET_BASENAMES = new Set([
  ".env",
  ".npmrc",
  ".netrc",
  ".pypirc",
  ".git-credentials",
  "id_rsa",
  "id_dsa",
  "id_ecdsa",
  "id_ed25519",
  "credentials",
  "credentials.json",
  "secrets.json",
  "secrets.yaml",
  "secrets.yml",
  "service-account.json",
]);
const SAFE_ENV_SUFFIXES = [".example", ".sample", ".template", ".dist", ".defaults"];
const SECRET_EXTENSIONS = [".pem", ".key", ".p12", ".pfx", ".keystore", ".jks"];

/** A process's environment on Linux: `/proc/self/environ`, `/proc/1/environ`, a thread's. */
const PROC_ENVIRON = /^\/proc\/[^/]+\/(task\/[^/]+\/)?environ$/;

/**
 * True for files that commonly hold credentials (`.env`, SSH keys, `.npmrc`, `*.pem`, ...),
 * a process's environment (`/proc/self/environ`) and the agent CLIs' own login files by name
 * (`./login-names`: `~/.codex/auth.json`, `.credentials.json`, ...).
 */
export function isSecretPath(target: string): boolean {
  const normalized = target
    .trim()
    .replace(/^["']|["']$/g, "")
    .replace(/\\/g, "/");
  const base = normalized.split("/").pop()?.toLowerCase() ?? "";
  if (!base) return false;
  if (PROC_ENVIRON.test(normalized)) return true;
  if (base === ".env" || base.startsWith(".env.")) {
    return !SAFE_ENV_SUFFIXES.some((s) => base.endsWith(s));
  }
  if (base.endsWith(".env") && base !== ".env") {
    // `process.env`, `import.meta.env`, `Deno.env` and `Bun.env` are code, not files.
    if (/^(process|deno|bun|(.+\.)?meta)\.env$/.test(base)) return false;
    return !base.includes("example");
  }
  if (SECRET_BASENAMES.has(base)) return true;
  if (SECRET_EXTENSIONS.some((ext) => base.endsWith(ext))) return true;
  if (isLoginFileName(normalized)) return true;
  return /(^|\/)\.(ssh|aws|gnupg|docker)\//i.test(normalized) && !base.endsWith(".pub");
}
