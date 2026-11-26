import { z } from "zod";
import { ProviderId } from "./common";

/** Dev-server definition in `.agent-rishi/project.json`. */
export const DevServerConfig = z.object({
  /** Shell command that starts the dev server, e.g. `pnpm dev`. */
  command: z.string().min(1),
  /** Port the dev server listens on, when known (used for discovery). */
  port: z.int().min(1).max(65535).optional(),
  /** Working directory relative to the repo root. */
  cwd: z.string().optional(),
});
export type DevServerConfig = z.infer<typeof DevServerConfig>;

/** How long a check may run when it sets no `timeoutSec` (10 minutes). */
export const CHECK_DEFAULT_TIMEOUT_SEC = 600;
/** Longest timeout a check may set (1 hour). */
export const CHECK_MAX_TIMEOUT_SEC = 3600;
/** Most checks a project may define. */
export const MAX_PROJECT_CHECKS = 20;

/**
 * One of a project's checks (§9 Project checks): a command such as `pnpm typecheck` or
 * `pnpm test` that passes when it exits 0. Agent Rishi runs it in a session's working directory
 * after each turn when the session keeps going until checks pass.
 */
export const ProjectCheck = z.object({
  /** Shell command, run in the session's working directory. */
  command: z.string().trim().min(1).max(2000),
  /** Kill the command after this many seconds. Default `CHECK_DEFAULT_TIMEOUT_SEC`. */
  timeoutSec: z.int().min(1).max(CHECK_MAX_TIMEOUT_SEC).optional(),
});
export type ProjectCheck = z.infer<typeof ProjectCheck>;

/**
 * `.agent-rishi/project.json` at a repository root (§9). Read by the runner after a worktree
 * is created: `setup` commands run in the new worktree (output streamed as
 * `workspace.setup` events), `devServer` feeds dev-server discovery and `defaultProvider`
 * is reported back to the server. `checks` are read by the server from the project's own
 * folder when a session is created, and frozen on it (`Session.checks`). Unknown keys are
 * ignored.
 */
export const ProjectConfigFile = z.object({
  /** Commands run in order in every new worktree, e.g. `pnpm install`. */
  setup: z.array(z.string().min(1)).default([]),
  /** A bare command string or a full definition. */
  devServer: z.union([z.string().min(1), DevServerConfig]).optional(),
  defaultProvider: ProviderId.optional(),
  /**
   * The project's checks, e.g. `pnpm typecheck` and `pnpm test`: a bare command string or a
   * definition with its own timeout. Sessions that keep going until checks pass run them after
   * each turn.
   */
  checks: z
    .array(z.union([z.string().trim().min(1).max(2000), ProjectCheck]))
    .max(MAX_PROJECT_CHECKS)
    .default([]),
});
export type ProjectConfigFile = z.infer<typeof ProjectConfigFile>;

/** Normalize `devServer` to its object form. */
export function devServerOf(config: ProjectConfigFile): DevServerConfig | undefined {
  const value = config.devServer;
  if (value === undefined) return undefined;
  return typeof value === "string" ? { command: value } : value;
}

/** Normalize `checks` to their object form, in order. */
export function checksOf(config: Pick<ProjectConfigFile, "checks"> | null): ProjectCheck[] {
  return (config?.checks ?? []).map((c) => (typeof c === "string" ? { command: c } : c));
}

/** A check's timeout in milliseconds. */
export function checkTimeoutMs(check: ProjectCheck): number {
  return (check.timeoutSec ?? CHECK_DEFAULT_TIMEOUT_SEC) * 1000;
}
