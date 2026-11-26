import { isPrivateAddressError, publicFetch } from "../network/public-fetch";
import { ServiceError } from "./errors";

/**
 * "Load image" (§15): the UI's Content-Security-Policy keeps the browser from loading a remote
 * image, so when the user asks to see one, the server fetches it. Through `publicFetch`, so
 * only the public internet is reached (never this computer or a private network, by link,
 * redirect or DNS answer), over https, with no cookie, referrer or credential. Only images
 * come back, within a size and time limit.
 */

export interface RemoteImage {
  contentType: string;
  body: Buffer;
}

export interface RemoteImageOptions {
  /** The downloader (tests script it); `publicFetch` otherwise. */
  fetch?: typeof fetch;
  maxBytes?: number;
  timeoutMs?: number;
}

export type FetchRemoteImage = (url: string) => Promise<RemoteImage>;

const MAX_BYTES = 10 * 1024 * 1024;
const TIMEOUT_MS = 15_000;
const MAX_REDIRECTS = 3;

/** Image types passed on; anything else (HTML, JSON, scripts) is refused. */
const IMAGE_TYPES = new Set([
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
  "image/avif",
  "image/bmp",
  "image/x-icon",
  "image/vnd.microsoft.icon",
  "image/svg+xml",
]);

const failed = (message: string) => new ServiceError(502, "fetch_failed", message);

/** Fetch one image from an http(s) URL (http is fetched over https), following up to three redirects. */
export async function fetchRemoteImage(
  url: string,
  opts: RemoteImageOptions = {},
): Promise<RemoteImage> {
  const doFetch = opts.fetch ?? publicFetch;
  const signal = AbortSignal.timeout(opts.timeoutMs ?? TIMEOUT_MS);
  let target = secureTarget(url);
  for (let redirects = 0; ; redirects++) {
    let res: Response;
    try {
      res = await doFetch(target, {
        redirect: "manual",
        headers: { accept: "image/*", "user-agent": "Agent Rishi" },
        signal,
      });
    } catch (error) {
      if (isPrivateAddressError(error)) {
        throw new ServiceError(
          403,
          "address_blocked",
          `${target.host} is not on the public internet`,
        );
      }
      throw failed(signal.aborted ? "The image timed out" : `Couldn't reach ${target.host}`);
    }
    const location = res.headers.get("location");
    if (res.status >= 300 && res.status < 400 && location) {
      await res.body?.cancel();
      if (redirects >= MAX_REDIRECTS) throw failed("The image redirected too many times");
      target = secureTarget(new URL(location, target).href);
      continue;
    }
    return readImage(res, opts.maxBytes ?? MAX_BYTES);
  }
}

/** The URL to fetch: http(s) only, no credentials, http upgraded to https. */
function secureTarget(url: string): URL {
  let target: URL;
  try {
    target = new URL(url);
  } catch {
    throw new ServiceError(400, "bad_url", "Not a valid URL");
  }
  if (target.protocol !== "http:" && target.protocol !== "https:") {
    throw new ServiceError(400, "bad_url", "Only http and https images can be loaded");
  }
  if (target.username || target.password) {
    throw new ServiceError(400, "bad_url", "URLs with credentials are refused");
  }
  if (target.protocol === "http:") target.protocol = "https:";
  return target;
}

async function readImage(res: Response, maxBytes: number): Promise<RemoteImage> {
  if (res.status !== 200) {
    await res.body?.cancel();
    throw failed(`The image's server answered ${res.status}`);
  }
  const contentType = (res.headers.get("content-type") ?? "").split(";")[0]?.trim().toLowerCase();
  if (!contentType || !IMAGE_TYPES.has(contentType)) {
    await res.body?.cancel();
    throw new ServiceError(415, "not_an_image", "That URL isn't an image");
  }
  const tooLarge = () => new ServiceError(413, "too_large", "The image is too large");
  if (Number(res.headers.get("content-length") ?? 0) > maxBytes) {
    await res.body?.cancel();
    throw tooLarge();
  }
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for await (const chunk of res.body ?? []) {
      size += chunk.length;
      if (size > maxBytes) throw tooLarge();
      chunks.push(chunk);
    }
  } catch (error) {
    await res.body?.cancel().catch(() => {});
    if (error instanceof ServiceError) throw error;
    throw failed("The image download was cut off");
  }
  return { contentType, body: Buffer.concat(chunks) };
}
