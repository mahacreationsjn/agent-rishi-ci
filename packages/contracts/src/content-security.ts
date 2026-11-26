import { z } from "zod";
import { Timestamp } from "./common";

/**
 * How the UI keeps Markdown from contacting other hosts (§15): the Content-Security-Policy the
 * server sends with the UI and the desktop app sets on its window, and the image fetch behind
 * "Load image". Agent replies and GitHub text can carry image URLs that encode data, so the
 * browser never loads a remote image by itself.
 */

/** Where the UI loads a remote image the user chose to see, through the server. */
export const REMOTE_IMAGE_PATH = "/api/remote-image";

/**
 * `POST /api/remote-image`: the user clicked **Load image** on this exact http or https URL.
 * Only the app's own request (JSON, no `<img>` can send it) gets an image through the server.
 */
export const RemoteImageRequest = z.object({
  url: z.url({ protocol: /^https?$/ }).max(2_048),
});
export type RemoteImageRequest = z.infer<typeof RemoteImageRequest>;

/**
 * The answer: `GET /api/remote-image/<id>` fetches the requested URL, once, until `expiresAt`
 * (about a minute). Any other request to the image fetch, `?url=` included, is refused.
 */
export const RemoteImageGrant = z.object({
  id: z.string().regex(/^[A-Za-z0-9_-]{16,64}$/),
  expiresAt: Timestamp,
});
export type RemoteImageGrant = z.infer<typeof RemoteImageGrant>;

/** The path an `<img>` loads a granted image from. */
export function remoteImagePath(id: string): string {
  return `${REMOTE_IMAGE_PATH}/${encodeURIComponent(id)}`;
}

/** A `Host` value (`127.0.0.1:4317`, `[::1]:80`, `my-pc.local`); nothing that could end a directive. */
const HOST = /^[a-z0-9.\-[\]:]+$/i;

/**
 * The UI's Content-Security-Policy:
 * - images, fonts and media only from Agent Rishi itself, `data:` and `blob:` (screencast frames,
 *   pasted images, recorded audio), so an `<img>` in Markdown can't reach another host;
 * - scripts only from Agent Rishi's own files: no inline or remote script, no `eval`;
 * - network requests only to Agent Rishi, its WebSockets included;
 * - never framed by another page, no plugins, no `<base>` or form posts elsewhere.
 *
 * `host` is the `Host` the UI was loaded from (`127.0.0.1:4317`): its `ws:` and `wss:` origins
 * are listed too, for browsers whose `'self'` doesn't cover WebSockets.
 */
export function uiContentSecurityPolicy(host?: string): string {
  const sockets = host && HOST.test(host) ? ` ws://${host} wss://${host}` : "";
  return [
    "default-src 'self'",
    "script-src 'self'",
    // Inline style attributes and the style tags UI libraries insert.
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob:",
    "font-src 'self' data:",
    "media-src 'self' data: blob:",
    `connect-src 'self'${sockets}`,
    "worker-src 'self' blob:",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'",
  ].join("; ");
}
