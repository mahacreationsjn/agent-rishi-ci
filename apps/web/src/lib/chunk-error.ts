/**
 * The messages browsers (and Vite's preload helper) give when a chunk loaded on demand can't be
 * fetched. After Agent Rishi updates, a tab that was already open still asks for the old hashed chunk
 * names, which are gone; reloading picks up the new build.
 */
const CHUNK_ERROR_PREFIXES = [
  "Failed to fetch dynamically imported module", // Chromium
  "error loading dynamically imported module", // Firefox
  "Importing a module script failed", // Safari
  "Unable to preload CSS", // Vite, a chunk's stylesheet
];

/** Whether `error` is a chunk that failed to load (as opposed to a bug in the code it holds). */
export function isChunkLoadError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : "";
  return CHUNK_ERROR_PREFIXES.some((prefix) => message.startsWith(prefix));
}
