import type { ProviderIssue, ProviderStatus, SetupCommand } from "@agent-rishi/contracts";
import { connectionLevel } from "@agent-rishi/providers";
import { base, type CheckResult, installFix } from "./check-base";
import { type LoginTool, loginFix } from "./tool-lookup";

/** The agent providers' rows: they show the runner's detection, never a check of their own. */
export const PROVIDER_CHECKS = [
  "claude",
  "codex",
  "opencode",
  "cursor",
  "gemini",
  "antigravity",
] as const satisfies readonly LoginTool[];
export type ProviderCheckId = (typeof PROVIDER_CHECKS)[number];

export function isProviderCheck(id: string): id is ProviderCheckId {
  return (PROVIDER_CHECKS as readonly string[]).includes(id);
}

/** Where the setup terminal and the shell its commands are quoted for. */
export interface ProviderCheckEnv {
  shell: string;
  platform: NodeJS.Platform;
}

/**
 * The file to type in the setup terminal for a sign-in, or null for the plain command name. A
 * detection reports an npm shim's script (`.../cli.js`), which a terminal can't run by itself.
 */
export function terminalProgram(executablePath: string | null | undefined): string | null {
  return executablePath && !/\.[cm]?js$/i.test(executablePath) ? executablePath : null;
}

/**
 * A provider's setup row from the runner's detection (Foundation §4.3): only `verified` is
 * `ok`. `credential_found` is a warning (signed in, but no real check has passed yet),
 * `configured` asks to sign in, and a provider with no level is missing (not installed, or the
 * installed copy can't run). Fix commands are the setup terminal's: the found copy by its path.
 */
export function providerCheck(
  id: ProviderCheckId,
  status: ProviderStatus,
  env: ProviderCheckEnv,
): CheckResult {
  const label = base(id).label;
  // An older runner reports no level: without a real check, nothing counts as verified.
  const level = status.level !== undefined ? status.level : connectionLevel(status, undefined);
  const fields = {
    ...base(id),
    installed: status.installed,
    version: status.version,
    executablePath: status.executablePath,
    loggedIn: status.loggedIn,
    authMethod: status.authMethod,
    account: status.account,
    loginExpiresAt: status.loginExpiresAt,
    ...(status.broken?.length ? { broken: status.broken } : {}),
    level,
    verifiedAt: level === "verified" ? (status.verifiedAt ?? null) : null,
  };
  const issue = (code: ProviderIssue["code"]) => status.issues.find((i) => i.code === code);
  const detail = status.issues.length
    ? { detail: status.issues.map((i) => i.message).join("\n") }
    : {};
  const login = loginFix(id, env.shell, terminalProgram(status.executablePath));

  if (!status.installed) {
    return {
      ...fields,
      state: "missing",
      message: issue("broken_install")?.message ?? `${label} is not installed`,
      fix: installFix(id, env.platform),
    };
  }
  if (level === null) {
    const problem = issue("version_unsupported") ?? status.issues[0];
    return {
      ...fields,
      state: "missing",
      message: problem?.message ?? `${label} is installed but can't run here`,
      ...detail,
      fix: fixFor(problem, id, env.platform),
    };
  }
  if (level === "configured") {
    if (status.loggedIn === false) {
      return {
        ...fields,
        state: "missing",
        message: `Not signed in to ${label}`,
        ...detail,
        fix: login,
      };
    }
    return {
      ...fields,
      state: "warning",
      message: `Could not confirm the ${label} login`,
      ...detail,
      fix: login,
    };
  }
  if (level === "credential_found") {
    return {
      ...fields,
      state: "warning",
      message: "Signed in, not verified yet",
      detail: [
        `Agent Rishi found ${label}'s login, but ${label} has not yet answered a models request with it (a check that costs no tokens). Re-check; if it still isn't verified, sign in again.`,
        ...status.issues.map((i) => i.message),
      ].join("\n"),
      fix: login,
    };
  }
  if (issue("login_expiring")) {
    return {
      ...fields,
      state: "warning",
      message: `Your ${label} login expires soon; sign in again`,
      ...detail,
      fix: login,
    };
  }
  if (status.authMethod === "free") {
    // OpenCode's own free models work without an account, and its server answered.
    return {
      ...fields,
      state: "warning",
      message: "Only free models: connect a provider for more",
      fix: login,
    };
  }
  return { ...fields, state: "ok", message: "Signed in and verified" };
}

/** The setup command for a detection issue's fix (an install keeps the docs link). */
function fixFor(
  problem: ProviderIssue | undefined,
  id: ProviderCheckId,
  platform: NodeJS.Platform,
): SetupCommand {
  if (!problem?.fix || problem.fix.kind === "install") return installFix(id, platform);
  return { kind: problem.fix.kind, command: problem.fix.command };
}
