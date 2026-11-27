import { z } from "zod";

/**
 * Editions (`docs/foundation.md` §1): Agent Rishi ships as Solo and as Enterprise, built from
 * one repository. Each edition lives in `editions/<id>` and describes itself with an
 * `EditionConfig`; the Foundation (`apps/*`, `packages/*`) never imports an edition.
 */
export const EditionId = z.enum(["solo", "enterprise"]);
export type EditionId = z.infer<typeof EditionId>;

/** An operating system an edition ships installers for (`process.platform` values). */
export const EditionPlatform = z.enum(["win32", "linux", "darwin"]);
export type EditionPlatform = z.infer<typeof EditionPlatform>;

/**
 * What an edition is. Features, default templates and profiles are added here as the
 * Foundation parts they switch are built.
 */
export const EditionConfig = z.strictObject({
  id: EditionId,
  /** Shown to people, e.g. "Agent Rishi Solo". */
  name: z.string().min(1),
  /** One sentence: who it is for. */
  summary: z.string().min(1),
  /** The systems it ships installers for; a release builds only these. */
  platforms: z.array(EditionPlatform).min(1),
});
export type EditionConfig = z.infer<typeof EditionConfig>;
