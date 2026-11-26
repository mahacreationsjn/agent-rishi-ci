import { z } from "zod";
import type { Role } from "./common";

/**
 * How strongly the token saver note asks a session to save tokens (#602):
 * - `off`: no note.
 * - `lite`: terse answers, the least code, narrow searches.
 * - `full`: also drops filler words and allows sentence fragments.
 * - `ultra`: also asks for one point per line and code over prose.
 * Every level keeps exact technical terms, the words not, never, no and only, and full sentences
 * for security warnings, irreversible steps and text that leaves the session.
 */
export const TokenSaverLevel = z.enum(["off", "lite", "full", "ultra"]);
export type TokenSaverLevel = z.infer<typeof TokenSaverLevel>;

/** A project's own token saver level, used instead of the global and role defaults. */
export const TokenSaverProjectOverride = z.object({ level: TokenSaverLevel });
export type TokenSaverProjectOverride = z.infer<typeof TokenSaverProjectOverride>;

/**
 * Token saver settings (`Settings.tokenSaver`). A session's level is its project's override,
 * else its role's default, else `default`. Applies to sessions started or resumed after a
 * change, through the provider's system prompt (`ProviderCapabilities.systemPrompt`).
 */
export const TokenSaverSettings = z.object({
  /** The level for every session without a role or project override. */
  default: TokenSaverLevel.default("off"),
  /** Per-role defaults; null (or absent) uses `default`. */
  roles: z
    .object({
      orchestrator: TokenSaverLevel.nullable().default(null),
      pm: TokenSaverLevel.nullable().default(null),
      agent: TokenSaverLevel.nullable().default(null),
    })
    .prefault({}),
  /** Overrides by project id; a PATCH with `null` for a project removes its override. */
  projects: z.record(z.string(), TokenSaverProjectOverride).default({}),
});
export type TokenSaverSettings = z.infer<typeof TokenSaverSettings>;

/** The level a session gets: project override, else role default, else the global default. */
export function tokenSaverLevel(
  settings: TokenSaverSettings,
  role: Role,
  projectId: string | null,
): TokenSaverLevel {
  const project = projectId ? settings.projects[projectId] : undefined;
  return project?.level ?? settings.roles[role] ?? settings.default;
}
