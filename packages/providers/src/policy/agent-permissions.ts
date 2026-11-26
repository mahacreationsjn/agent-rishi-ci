import type { RiskAssessment } from "./assessment";
import { commandWrite } from "./command-writes";
import { type PathContext, resolveAgainst } from "./paths";
import type { SimpleCommand } from "./shell";

/**
 * Agents' own permission files (§11.2). Cursor and Gemini CLI run what their allow-lists permit
 * without asking, so Agent Rishi never sees those calls. An agent that writes one (`echo … >
 * .cursor/cli.json`) would turn Agent Rishi's approvals off for itself and, once the file is merged,
 * for every later session in the project. So writing one asks at every level, Full included,
 * whichever agent writes it and wherever it is: the worktree, a folder in it, or the user's own
 * configuration.
 */

type Owner = "Cursor" | "Gemini CLI";

/** A path that holds an agent's permissions: one of its files, or a folder that holds them. */
export interface PermissionPath {
  owner: Owner;
  /** A folder holding them (`.cursor`, `.gemini/policies`): a copy into it may add one. */
  folder: boolean;
}

/**
 * What `target` is to an agent's permissions, compared in any case:
 * - Cursor: `.cursor/cli.json` (a project's), `cli-config.json` in `.cursor` or a `cursor`
 *   config folder (the user's);
 * - Gemini CLI: `settings.json` and `trustedFolders.json` in `.gemini` (a project's or the
 *   user's), the system `settings.json` and `system-defaults.json` in `gemini-cli`, and any
 *   policy file in `.gemini/policies` or `gemini-cli/policies`;
 * - the `.cursor` and `.gemini` folders themselves.
 */
export function agentPermissionPath(target: string, ctx: PathContext): PermissionPath | undefined {
  const parts = resolveAgainst(target, ctx)
    .replace(/\\/g, "/")
    .toLowerCase()
    .split("/")
    .filter(Boolean);
  const base = parts.at(-1) ?? "";
  const parent = parts.at(-2);
  const file = (owner: Owner) => ({ owner, folder: false });
  if (parent === ".cursor" && (base === "cli.json" || base === "cli-config.json")) {
    return file("Cursor");
  }
  if (parent === "cursor" && base === "cli-config.json") return file("Cursor");
  if (parent === ".gemini" && (base === "settings.json" || base === "trustedfolders.json")) {
    return file("Gemini CLI");
  }
  if (parent === "gemini-cli" && (base === "settings.json" || base === "system-defaults.json")) {
    return file("Gemini CLI");
  }
  const policies = parts.findIndex(
    (p, i) => p === "policies" && (parts[i - 1] === ".gemini" || parts[i - 1] === "gemini-cli"),
  );
  if (policies >= 0) return { owner: "Gemini CLI", folder: policies === parts.length - 1 };
  if (base === ".cursor") return { owner: "Cursor", folder: true };
  if (base === ".gemini") return { owner: "Gemini CLI", folder: true };
  return undefined;
}

/** A verdict on writing an agent's permissions, which every level asks about. */
export function agentPermissionsRisk(owner: Owner, target: string): RiskAssessment {
  return {
    risky: true,
    action: "file_change",
    reason: `Changes ${owner}'s own permissions (${target}): what they allow runs without Agent Rishi asking`,
    always: true,
  };
}

/** The verdict on writing `target` when it holds an agent's permissions, else undefined. */
export function agentPermissionsWrite(
  target: string,
  ctx: PathContext,
): RiskAssessment | undefined {
  const found = agentPermissionPath(target, ctx);
  return found ? agentPermissionsRisk(found.owner, target) : undefined;
}

/** A permission file named in code (`'.cursor/cli.json'`, `".gemini\\settings.json"`). */
const MENTION =
  /\.(cursor)[\\/]+cli(-config)?\.json|\.(gemini)[\\/]+(settings\.json|trustedfolders\.json|policies)/i;

/**
 * One simple command's write of an agent's permissions: a redirect onto one, inline code that
 * names one (`node -e`, `python -c`, a PowerShell `[IO.File]::WriteAllText(…)`), or an argument
 * that is one, for any command that may write its arguments (`tee`, `cp`, `mv`, `sed -i`,
 * `dd of=<file>`, `Set-Content`, `Copy-Item`, `git checkout -- <file>`, ...). Reads, searches,
 * listings and deletions don't count.
 */
export function agentPermissionsCommand(
  cmd: SimpleCommand,
  ctx: PathContext,
): RiskAssessment | undefined {
  return commandWrite(cmd, {
    write: (path) => agentPermissionsWrite(path, ctx),
    mention: (code) => {
      const named = MENTION.exec(code);
      return named ? agentPermissionsRisk(named[1] ? "Cursor" : "Gemini CLI", named[0]) : undefined;
    },
  });
}
