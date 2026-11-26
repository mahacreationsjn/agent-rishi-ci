import { RemoteImageRequest } from "@agent-rishi/contracts";
import { Hono } from "hono";
import { notFound } from "../services/errors";
import { type FetchRemoteImage, fetchRemoteImage } from "../services/remote-image";
import { RemoteImageGrants } from "../services/remote-image-grants";
import { jsonBody } from "./validate";

export interface RemoteImageRouteOptions {
  /** The downloader (tests script it); `fetchRemoteImage` otherwise. */
  fetchImage?: FetchRemoteImage;
  grants?: RemoteImageGrants;
}

/**
 * A remote image the user chose to load from a Markdown placeholder (§15, #341):
 * - `POST /api/remote-image` `{ url }`: the click. Answers a single-use id for that URL.
 * - `GET /api/remote-image/<id>`: the `<img>`. Fetches the granted URL once, served like a
 *   stored artifact: as an image only, never run as a page.
 * Nothing else fetches: `?url=`, or an unknown, expired or used id, answers 404.
 */
export function remoteImageRoutes(opts: RemoteImageRouteOptions = {}) {
  const fetchImage = opts.fetchImage ?? ((url: string) => fetchRemoteImage(url));
  const grants = opts.grants ?? new RemoteImageGrants();
  return new Hono()
    .post("/", jsonBody(RemoteImageRequest), (c) => c.json(grants.grant(c.req.valid("json").url)))
    .get("/:id", async (c) => {
      const url = grants.take(c.req.param("id"));
      if (url === undefined) {
        throw notFound("This image link has expired; load the image again", "image_not_found");
      }
      const image = await fetchImage(url);
      return c.body(new Uint8Array(image.body), 200, {
        "content-type": image.contentType,
        "content-length": String(image.body.length),
        "content-disposition": "inline",
        "x-content-type-options": "nosniff",
        // An SVG opened on its own stays inert: no script, no further loads.
        "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'; sandbox",
        "referrer-policy": "no-referrer",
        // The id works once: the browser shows the image again from its cache.
        "cache-control": "private, max-age=3600",
      });
    });
}
