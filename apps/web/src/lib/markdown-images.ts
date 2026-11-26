import { REMOTE_IMAGE_PATH } from "@agent-rishi/contracts";

/**
 * What an image in Markdown may load (#317). Agent replies and GitHub text are untrusted, and
 * an image URL can carry data to its host the moment it renders, so only images that stay on
 * this machine load by themselves:
 * - `local`: inline (`data:image/…`, `blob:`), a stored artifact on Agent Rishi's own origin, or
 *   Streamdown's own placeholder while an image streams in;
 * - `remote`: anything on another host, shown as a placeholder until the user loads it;
 * - `blocked`: everything else (other schemes, other Agent Rishi URLs), never loaded.
 */
export type ImageSource =
  | { kind: "local" }
  | { kind: "remote"; url: string; host: string }
  | { kind: "blocked" };

const ARTIFACT_PATH = /^\/api\/artifacts\/[^/]+$/;

export function imageSource(src: unknown, origins: readonly string[]): ImageSource {
  if (typeof src !== "string") return { kind: "blocked" };
  const value = src.trim();
  if (/^(data:image\/|blob:|streamdown:incomplete-image$)/i.test(value)) return { kind: "local" };
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return { kind: "blocked" };
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return { kind: "blocked" };
  if (!origins.includes(url.origin)) return { kind: "remote", url: url.href, host: url.host };
  if (ARTIFACT_PATH.test(url.pathname) && !url.search) return { kind: "local" };
  // A link to Agent Rishi's image fetch (the old `?url=` form) names the image it was for; it
  // never loads as it is, but its placeholder can name and load the real image (#341).
  const inner = url.pathname === REMOTE_IMAGE_PATH ? url.searchParams.get("url") : null;
  if (inner) {
    const judged = imageSource(inner, origins);
    return judged.kind === "remote" ? judged : { kind: "blocked" };
  }
  return { kind: "blocked" };
}
