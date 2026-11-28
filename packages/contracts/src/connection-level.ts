import { z } from "zod";

/**
 * How far a provider connection is known to work (Foundation §4.3). One detection, the
 * runner's, reports it; setup displays it.
 *
 * - `configured`: the CLI is installed and runs (or, for a key-based connection, a key and a
 *   base URL are set);
 * - `credential_found`: there is evidence of a login or a key (a login status command, a
 *   login file, a keyring entry, a key in the environment);
 * - `verified`: a real check passed with that login: a protocol handshake, or a models request
 *   that costs no tokens. Only this level counts as ready.
 *
 * A provider that is not installed, or whose installed copy can't run, has no level (`null`).
 */
export const ConnectionLevel = z.enum(["configured", "credential_found", "verified"]);
export type ConnectionLevel = z.infer<typeof ConnectionLevel>;

/** Levels from lowest to highest, for comparisons. */
export const CONNECTION_LEVELS: readonly ConnectionLevel[] = ConnectionLevel.options;

/** Whether `level` is at least `atLeast` (`null`, no level, is below every level). */
export function hasConnectionLevel(
  level: ConnectionLevel | null | undefined,
  atLeast: ConnectionLevel,
): boolean {
  if (!level) return false;
  return CONNECTION_LEVELS.indexOf(level) >= CONNECTION_LEVELS.indexOf(atLeast);
}
