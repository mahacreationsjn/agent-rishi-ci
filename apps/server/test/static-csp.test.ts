import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { type RunningServer, startServer } from "../src";
import { removeTree } from "./support/remove-tree";

const TOKEN = "c".repeat(64);
let home: string;
let server: RunningServer | undefined;

afterEach(async () => {
  await server?.close();
  server = undefined;
  await removeTree(home);
});

async function start() {
  home = mkdtempSync(join(tmpdir(), "agent-rishi-csp-"));
  const webDir = join(home, "web");
  mkdirSync(join(webDir, "assets"), { recursive: true });
  writeFileSync(join(webDir, "index.html"), "<p>ui</p>");
  writeFileSync(join(webDir, "assets", "app.js"), "export {}");
  server = await startServer({
    port: 0,
    dataDir: home,
    token: TOKEN,
    runner: false,
    secrets: "memory",
    checkSetupOnStart: false,
    webDir,
  });
  return server;
}

describe("web UI Content-Security-Policy (#317)", () => {
  it("sends a CSP that limits images to the server, data: and blob:", async () => {
    const s = await start();
    const cookie = { authorization: `Bearer ${TOKEN}` };
    const port = new URL(s.url).port;
    for (const path of ["/", "/projects/p1", "/index.html", "/assets/app.js", "/api/health"]) {
      const res = await fetch(`${s.url}${path}`, { headers: cookie });
      expect(res.status, path).toBe(200);
      const csp = res.headers.get("content-security-policy");
      expect(csp, path).toMatch(/img-src 'self' data: blob:/);
      expect(csp).toMatch(/frame-ancestors 'none'/);
      expect(csp).toMatch(/script-src 'self';/);
      expect(csp).toContain(`connect-src 'self' ws://127.0.0.1:${port} wss://127.0.0.1:${port}`);
    }
    // The "Agent Rishi is locked" page too.
    const locked = await fetch(s.url, { headers: { accept: "text/html" } });
    expect(locked.status).toBe(401);
    expect(locked.headers.get("content-security-policy")).toMatch(/img-src 'self' data: blob:/);
  });

  it("serves remote images only through the guarded fetch, never from this machine", async () => {
    const s = await start();
    const auth = { authorization: `Bearer ${TOKEN}` };
    const click = (url: string, headers: Record<string, string> = auth) =>
      fetch(`${s.url}/api/remote-image`, {
        method: "POST",
        headers: { ...headers, "content-type": "application/json" },
        body: JSON.stringify({ url }),
      });
    const grant = (await (await click(`${s.url}/api/health`)).json()) as { id: string };
    const local = await fetch(`${s.url}/api/remote-image/${grant.id}`, { headers: auth });
    expect(local.status).toBe(403);
    expect(((await local.json()) as { error: { code: string } }).error.code).toBe(
      "address_blocked",
    );
    expect((await click("javascript:alert(1)")).status).toBe(400);
    // Only the click's id fetches (#341): `?url=` fetches nothing, even with the token.
    const direct = `${s.url}/api/remote-image?url=${encodeURIComponent("https://a.example/x.png")}`;
    expect((await fetch(direct, { headers: auth })).status).toBe(404);
    // The install token is needed like everywhere else.
    expect((await click("https://a.example/x.png", {})).status).toBe(401);
  });
});
