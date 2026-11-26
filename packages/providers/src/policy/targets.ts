import { agentPermissionsWrite } from "./agent-permissions";
import { AGENT_RISHI_WHAT } from "./agent-rishi-command";
import {
  agentRishiAccess,
  credentialsRisk,
  forReading,
  touchesAgentRishiCredentials,
  touchesAgentRishiHome,
} from "./agent-rishi-home";
import { type RiskAssessment, risky, SAFE } from "./assessment";
import type { FunctionTable } from "./blocks";
import {
  isInWorkspace,
  isSecretPath,
  isWritable,
  type PathContext,
  providerPath,
  resolveAgainst,
  SHELL_DRIVES,
} from "./paths";
import { projectConfigWrite } from "./project-config";
import { loginRisk, touchesProviderLogin } from "./provider-logins";
import { braceAlternatives } from "./secrets";
import type { ShellDialect } from "./shell";
import type { Input } from "./stdin-scripts";

/**
 * What the risk classifier (`./risk`) judges besides command lines (§11.2): a file written or
 * read, a file-name search and a web fetch, and the context every rule reads.
 */

export interface RiskContext extends PathContext {
  /** Hosts the agent may fetch freely. When omitted, web fetches are not flagged. */
  allowedHosts?: readonly string[];
  /** The shell a command runs in, for its quoting rules. Default `auto`. */
  shell?: ShellDialect;
  /** The branch the session owns, which it may force-push with a lease (§11.2). */
  ownBranch?: string;
  /** The branch checked out in the worktree. Defaults to reading `cwd`'s git `HEAD`. */
  currentBranch?: () => string | undefined;
  /** The functions the command line being read has defined (`./blocks`); callers leave it out. */
  functions?: FunctionTable;
  /** What the commands being read get on their input (`./stdin-scripts`); callers leave it out. */
  stdin?: Input;
}

/**
 * Classify a file write/edit. The worktree, extra roots and OS temp are fine, secrets files in
 * the worktree included: writing one (`cp .env.example .env`) reads nothing. A secrets file in
 * temp counts as outside the worktree, so Full autonomy (which only asks for writes outside the
 * worktree) still asks for it. Agent Rishi's own home (its credential files, and anything else
 * outside the session's own worktree there) and agents' own allow-lists (`./agent-permissions`)
 * ask at every level. Agent Rishi's project config (`./project-config`) asks at Auto. On Windows a
 * PowerShell drive's item (`HKCU:\…`, `Cert:\…`, or a relative path after a `cd` there) is never
 * in the worktree, except on the shell's own `Env:`, `Variable:`, `Function:` and `Alias:`
 * drives; `FileSystem::C:\x` and `Temp:\x` are the files they name.
 */
export function classifyWrite(target: string, ctx: RiskContext): RiskAssessment {
  const provider = providerPath(target, ctx);
  if (provider?.path !== undefined) return classifyWrite(provider.path, ctx);
  if (provider) {
    if (SHELL_DRIVES.has(provider.drive)) return SAFE;
    return risky("outside_worktree", `Writes ${target}, outside the worktree`);
  }
  const access = agentRishiAccess(target, ctx);
  if (access) return credentialsRisk(`Writes ${AGENT_RISHI_WHAT[access]}: ${target}`);
  const permissions = agentPermissionsWrite(target, ctx);
  if (permissions) return permissions;
  if (!isWritable(target, ctx))
    return risky("outside_worktree", `Writes ${target}, outside the worktree`);
  if (isSecretPath(target) && !isInWorkspace(target, ctx)) {
    return risky("outside_worktree", `Writes the secrets file ${target}, outside the worktree`);
  }
  return projectConfigWrite(target, ctx) ?? SAFE;
}

/**
 * Classify a file read or search. Reads anywhere are fine except credential files and Agent Rishi's
 * own home: anything there outside the session's own worktree and its own artifacts folder, and
 * the agent CLIs' logins (or a folder holding them), ask at every level.
 */
export function classifyRead(target: string, ctx: RiskContext): RiskAssessment {
  const access = agentRishiAccess(target, forReading(ctx));
  if (access) return credentialsRisk(`Reads ${AGENT_RISHI_WHAT[access]}: ${target}`);
  if (touchesProviderLogin(target, ctx)) return loginRisk(`Reads an agent CLI's login: ${target}`);
  if (isSecretPath(target)) return risky("secrets", `Reads the secrets file ${target}`);
  return SAFE;
}

/**
 * Classify a file-name search: `pattern` (Claude's Glob, or a search's `--glob` filter) from
 * `base` (default: the current directory). Listing names reads nothing, so only a pattern that
 * reaches Agent Rishi's own home (its credential files, or anything outside the session's own
 * worktree and artifacts folder there) asks; `{a,b}` alternatives are followed.
 */
export function classifyGlob(
  pattern: string,
  base: string | undefined,
  ctx: RiskContext,
): RiskAssessment {
  if (!pattern.trim()) return SAFE;
  const dir = base ? resolveAgainst(base, ctx) : (ctx.dir ?? ctx.cwd);
  const alts = braceAlternatives(pattern);
  if (alts.some((alt) => touchesAgentRishiCredentials(alt, { ...ctx, dir }))) {
    return credentialsRisk(`Lists Agent Rishi's own credential files: ${pattern}`);
  }
  const reaches = alts.some((alt) => touchesAgentRishiHome(alt, forReading({ ...ctx, dir })));
  return reaches ? credentialsRisk(`Lists Agent Rishi's own home: ${pattern}`) : SAFE;
}

/** Classify a web fetch. Only flagged when the context has an allowlist of hosts. */
export function classifyFetch(url: string, ctx: RiskContext): RiskAssessment {
  if (!ctx.allowedHosts) return SAFE;
  let host: string;
  try {
    host = new URL(url).hostname.toLowerCase();
  } catch {
    return risky("network", `Fetches an unparseable URL: ${url}`);
  }
  const allowed = ctx.allowedHosts.some((h) => {
    const rule = h.toLowerCase();
    return rule.startsWith("*.") ? host.endsWith(rule.slice(1)) : host === rule;
  });
  return allowed
    ? SAFE
    : risky("network", `Fetches ${host}, which is not on the allowed host list`);
}
