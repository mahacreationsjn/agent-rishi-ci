import { existsSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import type { ProviderIssue, ProviderStatus } from "@agent-rishi/contracts";
import { brokenInstallMessage, type DetectExeOptions, lookupForDetect } from "../util/detect-exe";
import type { ResolvedCommand } from "../util/exec";
import { compareVersions } from "../util/version";
import { hasAgyKeyringEntry } from "./keyring";
import type { AgyProbe } from "./probe";
import { agyDir } from "./settings";

/**
 * Oldest Antigravity CLI Agent Rishi supports: 1.5.12 replays a loaded session's history before it
 * answers `session/load`, runs commands in the session's folder and reports MCP support with
 * `--process-per-session`.
 */
export const AGY_MIN_VERSION = "1.5.12";
export const AGY_INSTALL_COMMAND = "curl -fsSL https://antigravity.google/cli/install.sh | bash";
/** Its installer for this platform: PowerShell on Windows, the shell script elsewhere. */
export function agyInstallCommand(platform: NodeJS.Platform = process.platform): string {
  return platform === "win32"
    ? "irm https://antigravity.google/cli/install.ps1 | iex"
    : AGY_INSTALL_COMMAND;
}
export const AGY_UPGRADE_COMMAND = "agy update";
/** Signs in with Google by pasting a code in the terminal, then exits (works over SSH too). */
export const AGY_LOGIN_COMMAND = "agy acp --login";

/** Whether an Antigravity CLI version is one Agent Rishi supports. */
export function isSupportedAgyVersion(version: string | null | undefined): boolean {
  return !!version && compareVersions(version, AGY_MIN_VERSION) >= 0;
}

/** "Antigravity CLI 1.4.0 is too old (needs 1.5.12+)". */
export function agyTooOldMessage(version: string | null | undefined): string {
  return `Antigravity CLI ${version || "(unknown version)"} is too old (needs ${AGY_MIN_VERSION}+)`;
}

/** The login Antigravity CLI would use, as far as Agent Rishi can tell without reading it. */
export interface AgyAuth {
  loggedIn: boolean | null;
  authMethod: string | null;
}

/**
 * Look for evidence of a Google sign-in or an API key without reading any stored token.
 * A missing entry can mean an unsupported or inaccessible keyring, so report unknown.
 */
export async function readAgyAuth(
  home: string = homedir(),
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): Promise<AgyAuth> {
  if (existsSync(path.join(agyDir(home), "antigravity-oauth-token"))) {
    return { loggedIn: true, authMethod: "oauth-personal" };
  }
  if (env.GEMINI_API_KEY?.trim()) return { loggedIn: true, authMethod: "gemini-api-key" };
  if (await hasAgyKeyringEntry(platform)) return { loggedIn: true, authMethod: "oauth-personal" };
  return { loggedIn: null, authMethod: null };
}

export interface AgyDetectOptions extends DetectExeOptions {
  /** Start `agy acp` once to check it answers (`probeAgy`); supported versions only. */
  probe?: (exe: ResolvedCommand, version: string | null) => Promise<AgyProbe>;
  /** Reads the login (default `readAgyAuth()`). */
  auth?: () => AgyAuth | Promise<AgyAuth>;
}

/**
 * Find a working `agy` (PATH, then `~/.local/bin`, where its installer puts it), check its
 * version and that its ACP server answers, and see whether it is signed in (§14). The user's own
 * login is reused; credentials are never read or copied. Never throws.
 */
export async function detectAgy(opts: AgyDetectOptions = {}): Promise<ProviderStatus> {
  const status: ProviderStatus = {
    providerId: "antigravity",
    installed: false,
    version: null,
    executablePath: null,
    loggedIn: null,
    authMethod: null,
    account: null,
    loginExpiresAt: null,
    supported: false,
    issues: [],
    checkedAt: new Date().toISOString(),
  };
  const issues: ProviderIssue[] = [];
  const install = { kind: "install" as const, command: AGY_INSTALL_COMMAND };
  const upgrade = { kind: "upgrade" as const, command: AGY_UPGRADE_COMMAND };
  const lookup = await lookupForDetect("agy", {
    ...opts,
    timeoutMs: opts.timeoutMs ?? 15_000,
    minVersion: AGY_MIN_VERSION,
  });
  const broken = lookup.broken.length > 0 ? { broken: lookup.broken } : {};
  const exe = lookup.command;
  if (!exe) {
    issues.push(
      lookup.broken.length > 0
        ? {
            code: "broken_install",
            message: brokenInstallMessage("Antigravity CLI", lookup.broken),
            fix: install,
          }
        : {
            code: "not_installed",
            message: "Antigravity CLI is not installed (no `agy` on PATH or in ~/.local/bin).",
            fix: install,
          },
    );
    return { ...status, ...broken, issues };
  }
  const found = {
    ...status,
    ...broken,
    installed: true,
    version: lookup.version,
    executablePath: exe.kind === "node-script" ? exe.script : exe.path,
  };
  if (!isSupportedAgyVersion(lookup.version)) {
    issues.push({
      code: "version_unsupported",
      message: `${agyTooOldMessage(lookup.version)}. Update it.`,
      fix: upgrade,
      minVersion: AGY_MIN_VERSION,
    });
    return { ...found, issues };
  }
  const auth = await (opts.auth?.() ?? readAgyAuth());
  let supported = true;
  const probe = await opts.probe?.(exe, lookup.version);
  if (probe && !probe.acp) {
    supported = false;
    issues.push({
      code: "version_unsupported",
      message: `Antigravity CLI ${lookup.version} did not start its ACP server (\`agy acp\`)${probe.error ? `: ${probe.error}` : ""}. Update it.`,
      fix: upgrade,
    });
  }
  if (auth.loggedIn === false) {
    issues.push({
      code: "not_logged_in",
      message: `Antigravity CLI is not signed in. Run \`${AGY_LOGIN_COMMAND}\` and sign in with Google.`,
      fix: { kind: "login", command: AGY_LOGIN_COMMAND },
    });
  } else if (auth.loggedIn === null) {
    issues.push({
      code: "detect_failed",
      message: "Could not confirm the Antigravity CLI login.",
      fix: { kind: "login", command: AGY_LOGIN_COMMAND },
    });
  }
  return { ...found, supported, loggedIn: auth.loggedIn, authMethod: auth.authMethod, issues };
}
