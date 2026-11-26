import { readFileSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { BindHost } from "../src/network/listener";
import {
  auth,
  cookieOf,
  dir,
  enable,
  errorOf,
  from,
  GOOD,
  json,
  LAN,
  listener,
  local,
  network,
  PHONE,
  PORT,
  phone,
  signIn,
  statusOf,
  TOKEN,
  useNetworkApp,
} from "./support/network-app";

useNetworkApp();

/**
 * A reverse proxy on this machine (Tailscale Serve): its connections come from 127.0.0.1 but
 * name the trusted origin's host, which must make them remote (§15.1).
 */
describe("trusted origin through a proxy on this machine", () => {
  const ORIGIN = "https://box.tail1234.ts.net:8445";
  const HOST = "box.tail1234.ts.net:8445";
  const proxied = (path: string, init: RequestInit & { host?: string; xff?: string } = {}) => {
    const headers = new Headers(init.headers);
    if (init.xff) headers.set("x-forwarded-for", init.xff);
    if (!headers.has("origin") && init.method && init.method !== "GET")
      headers.set("origin", ORIGIN);
    return from("127.0.0.1", path, { ...init, headers, host: init.host ?? HOST });
  };
  const proxiedSignIn = (password = GOOD, xff = "100.64.0.7") =>
    proxied("/api/auth/sign-in", {
      ...json({ password }, { "user-agent": "Mozilla/5.0 (iPhone)" }),
      xff,
    });

  beforeEach(async () => {
    network.store.addTrustedOrigin(ORIGIN);
    await enable();
  });

  it("answers 401 sign_in_required without a session, and the API with one", async () => {
    const res = await proxied("/api/snapshot");
    expect(res.status).toBe(401);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe("sign_in_required");
    const cookie = cookieOf(await proxiedSignIn());
    expect(cookie).toMatch(/^agent_rishi_session_/);
    expect((await proxied("/api/snapshot", { headers: { cookie } })).status).toBe(200);
    expect((await proxied("/ws", { headers: { cookie } })).status).toBe(200);
  });

  it("serves the UI shell and sign-in status to a signed-out device", async () => {
    expect((await proxied("/")).status).toBe(200);
    const status = (await (await proxied("/api/auth/status")).json()) as { remote: boolean };
    expect(status.remote).toBe(true);
  });

  it("never accepts the install token: header, cookie or ?token=", async () => {
    expect((await proxied("/api/snapshot", { headers: auth })).status).toBe(401);
    expect(
      (
        await proxied("/api/snapshot", {
          headers: { cookie: `agent_rishi_token_${PORT}=${TOKEN}` },
        })
      ).status,
    ).toBe(401);
    expect((await proxied(`/api/snapshot?token=${TOKEN}`)).status).toBe(401);
    expect((await proxied("/ws", { headers: auth })).status).toBe(401);
    const page = await proxied(`/?token=${TOKEN}`);
    expect(page.status).toBe(200); // the public shell, no cookie, no redirect
    expect(page.headers.get("set-cookie")).toBeNull();
  });

  it("answers 404 for /mcp and the browser relay, even with a session", async () => {
    const cookie = cookieOf(await proxiedSignIn());
    for (const path of ["/mcp", "/api/browser/relay"]) {
      expect((await proxied(path, { headers: { cookie } })).status).toBe(404);
      expect((await proxied(path, { headers: auth })).status).toBe(404);
    }
  });

  it("can't change network access, trusted origins or the password", async () => {
    const cookie = cookieOf(await proxiedSignIn());
    const headers = { cookie, "content-type": "application/json" };
    const attempts: [string, string, unknown][] = [
      ["PUT", "/api/network", { enabled: false }],
      ["PUT", "/api/network", { loopbackOnly: true }],
      ["POST", "/api/network/password", { password: "another-long-passphrase-here" }],
      ["POST", "/api/network/origins", { url: "https://evil.example" }],
    ];
    for (const [method, path, body] of attempts) {
      const res = await proxied(path, { method, headers, body: JSON.stringify(body) });
      expect(res.status, `${method} ${path}`).toBe(403);
    }
    expect(
      (
        await proxied(`/api/network/origins?url=${encodeURIComponent(ORIGIN)}`, {
          method: "DELETE",
          headers,
        })
      ).status,
    ).toBe(403);
    expect(network.store.trustedOrigins).toEqual([ORIGIN]);
    expect(network.enabled).toBe(true);
    // A device may see them.
    const seen = await statusOf(await proxied("/api/network", { headers: { cookie } }));
    expect(seen.trustedOrigins).toEqual([ORIGIN]);
    expect(seen.remote).toBe(true);
  });

  it("is refused with network access off, and grants nothing", async () => {
    await network.setEnabled(false);
    const res = await proxied("/api/snapshot", { headers: auth });
    expect(res.status).toBe(403);
    expect(await res.text()).toBe("Network access is off");
    expect((await proxied("/")).status).toBe(403);
    expect((await proxiedSignIn()).status).toBe(403);
  });

  it("still refuses an untrusted *.ts.net host and unlisted ports", async () => {
    for (const host of [
      "evil.tail1234.ts.net:8445",
      "box.tail1234.ts.net",
      "box.tail1234.ts.net:9",
    ]) {
      const res = await proxied("/api/auth/status", { host });
      expect(res.status, host).toBe(403);
      expect(await res.text()).toBe("Forbidden host");
    }
  });

  it("refuses a trusted Origin with another Host, and another Origin with the trusted Host", async () => {
    const trustedOnLoopback = await local("/api/auth/status", { headers: { origin: ORIGIN } });
    expect(trustedOnLoopback.status).toBe(403);
    expect(await trustedOnLoopback.text()).toBe("Forbidden origin");
    const trustedOnLan = await phone("/api/auth/status", { headers: { origin: ORIGIN } });
    expect(trustedOnLan.status).toBe(403);
    for (const origin of [
      `http://127.0.0.1:${PORT}`,
      `http://${HOST}`,
      "null",
      "https://evil.example",
    ]) {
      const res = await proxied("/api/auth/status", { headers: { origin } });
      expect(res.status, origin).toBe(403);
    }
    expect((await proxied("/api/auth/status", { headers: { origin: ORIGIN } })).status).toBe(200);
  });

  it("matches the host case-insensitively and a default port as :443", async () => {
    network.store.addTrustedOrigin("https://plain.tail1234.ts.net");
    expect((await proxied("/api/auth/status", { host: "PLAIN.tail1234.TS.net" })).status).toBe(200);
    expect((await proxied("/api/auth/status", { host: "plain.tail1234.ts.net:443" })).status).toBe(
      200,
    );
    expect((await proxied("/api/auth/status", { host: "BOX.tail1234.ts.net:8445" })).status).toBe(
      200,
    );
  });

  it("sets a Secure cookie from the matched origin, though the request URL is http", async () => {
    const res = await proxiedSignIn();
    expect(res.status).toBe(200);
    expect(res.headers.get("set-cookie")).toMatch(/Secure/);
    expect(res.headers.get("set-cookie")).toMatch(/HttpOnly/i);
    // Not Secure when it came by the LAN address.
    expect((await signIn()).headers.get("set-cookie")).not.toMatch(/Secure/);
  });

  it("throttles per forwarded address, not per the proxy's 127.0.0.1", async () => {
    for (let i = 0; i < 3; i++)
      expect((await proxiedSignIn("wrong password, sorry")).status).toBe(401);
    expect((await proxiedSignIn(GOOD)).status).toBe(429);
    // Another device behind the same proxy is unaffected.
    expect((await proxiedSignIn(GOOD, "100.64.0.8")).status).toBe(200);
  });

  it("stops attempts that rotate X-Forwarded-For with one shared limit", async () => {
    for (let i = 0; i < 10; i++) {
      expect((await proxiedSignIn("wrong password, sorry", `100.64.1.${i}`)).status).toBe(401);
    }
    const next = await proxiedSignIn(GOOD, "100.64.9.9");
    expect(next.status).toBe(429);
    expect((await errorOf(next)).error.code).toBe("rate_limited");
    // The limit is for the proxy path only: a direct sign-in is unaffected.
    expect((await signIn(GOOD, "192.168.1.50")).status).toBe(200);
  });

  it("ignores X-Forwarded-For on requests that did not come through the proxy", async () => {
    for (let i = 0; i < 3; i++) {
      const res = await from(PHONE, "/api/auth/sign-in", {
        host: `${LAN}:${PORT}`,
        ...json({ password: "wrong password, sorry" }, { "x-forwarded-for": `100.64.2.${i}` }),
      });
      expect(res.status).toBe(401);
    }
    const limited = await from(PHONE, "/api/auth/sign-in", {
      host: `${LAN}:${PORT}`,
      ...json({ password: GOOD }, { "x-forwarded-for": "100.64.2.99" }),
    });
    expect(limited.status).toBe(429);
    // A loopback request carrying it for an untrusted host was forwarded by a proxy: refused.
    expect(
      (await local("/api/snapshot", { headers: { ...auth, "x-forwarded-for": "1.2.3.4" } })).status,
    ).toBe(403);
    // Without proxy headers this machine is unaffected.
    expect((await local("/api/snapshot", { headers: auth })).status).toBe(200);
  });

  /**
   * Tailscale Serve picks its backend by TLS SNI and passes on the client's own `Host`, adding
   * `X-Forwarded-Host` (that same Host), `-Proto` and `-For`. A tailnet client can therefore
   * name a loopback host through the proxy; it must still never count as this machine.
   */
  it("refuses a proxied request that names a loopback host, with access on or off", async () => {
    const serve = (path: string, host: string, headers: Record<string, string> = {}) =>
      from("127.0.0.1", path, {
        host,
        headers: {
          host,
          "x-forwarded-host": host,
          "x-forwarded-proto": "https",
          "x-forwarded-for": "100.64.0.66",
          ...headers,
        },
      });
    const proxyHeaders: Record<string, string>[] = [
      { forwarded: "for=100.64.0.66;proto=https" },
      { "x-real-ip": "100.64.0.66" },
    ];
    for (const on of [true, false]) {
      await network.setEnabled(on);
      for (const host of [`127.0.0.1:${PORT}`, `localhost:${PORT}`, `[::1]:${PORT}`]) {
        for (const path of ["/mcp", "/api/health", "/api/auth/status", "/", "/ws"]) {
          const res = await serve(path, host);
          expect(res.status, `${on} ${host} ${path}`).toBe(403);
          expect(await res.text()).toBe("Forbidden host");
        }
        expect((await serve("/api/snapshot", host, auth)).status).toBe(403);
        expect((await serve(`/api/snapshot?token=${TOKEN}`, host)).status).toBe(403);
      }
      // Any one forwarding header is enough, without the others.
      for (const headers of proxyHeaders) {
        const res = await local("/mcp", { headers });
        expect(res.status, JSON.stringify(headers)).toBe(403);
      }
    }
  });

  it("shows the forwarded address as proxy-reported in devices and the log", async () => {
    await proxiedSignIn("wrong password, sorry", "100.64.3.3");
    await proxiedSignIn(GOOD, "100.64.3.4");
    const status = await statusOf(await local("/api/network", { headers: auth }));
    expect(status.devices[0]).toMatchObject({ address: "100.64.3.4", addressViaProxy: true });
    const log = readFileSync(join(dir, "remote-access.log"), "utf8");
    expect(log).toContain("failed sign-in from 100.64.3.3 (reported by proxy)");
    // A missing or bogus header is recorded as unknown, never as the proxy's 127.0.0.1.
    await proxiedSignIn("wrong password, sorry", "not-an-ip");
    expect(readFileSync(join(dir, "remote-access.log"), "utf8")).toContain(
      "from unknown (reported by proxy)",
    );
  });

  it("puts wss:// for the trusted host in connect-src", async () => {
    const csp = (await proxied("/csp")).headers.get("content-security-policy") ?? "";
    expect(csp).toContain(`wss://${HOST}`);
  });

  it("is an ordinary loopback host again once the origin is removed", async () => {
    network.store.removeTrustedOrigin(ORIGIN);
    const res = await proxied("/api/snapshot", { headers: auth });
    expect(res.status).toBe(403);
    expect(await res.text()).toBe("Forbidden host");
  });

  it("reserves the shared limit while a password is being checked", async () => {
    let finish: (ok: boolean) => void = () => {};
    let calls = 0;
    network.store.checkPassword = () => {
      calls++;
      return new Promise<boolean>((resolve) => {
        finish = resolve;
      });
    };
    const first = proxiedSignIn("anything at all", "100.64.5.1");
    await vi.waitFor(() => expect(calls).toBe(1));
    // Other devices behind the proxy, and the same one again, wait: no second check starts.
    for (const xff of ["100.64.5.2", "100.64.5.3", "100.64.5.1"]) {
      const res = await proxiedSignIn(GOOD, xff);
      expect(res.status, xff).toBe(429);
    }
    expect(calls).toBe(1);
    finish(false);
    expect((await first).status).toBe(401);
    // The reservation is released: the next attempt runs.
    const next = proxiedSignIn(GOOD, "100.64.5.2");
    await vi.waitFor(() => expect(calls).toBe(2));
    finish(true);
    expect((await next).status).toBe(200);
  });

  it("releases the reservation when the check throws", async () => {
    network.store.checkPassword = () => Promise.reject(new Error("boom"));
    expect((await proxiedSignIn(GOOD, "100.64.6.1")).status).toBe(500);
    network.store.checkPassword = async () => true;
    expect((await proxiedSignIn(GOOD, "100.64.6.2")).status).toBe(200);
  });
});

describe("network policy changes", () => {
  it("run one at a time, and a failed bind puts the saved policy back", async () => {
    await network.setPassword({ password: GOOD });
    const order: string[] = [];
    let release: () => void = () => {};
    listener.rebind = async (host: BindHost) => {
      order.push(`start ${host}`);
      if (order.length === 1) await new Promise<void>((r) => (release = r));
      listener.host = host;
      order.push(`end ${host}`);
    };
    const wide = network.update({ enabled: true });
    const narrow = network.update({ loopbackOnly: true });
    await vi.waitFor(() => expect(order).toEqual(["start 0.0.0.0"]));
    release();
    await Promise.all([wide, narrow]);
    expect(order).toEqual(["start 0.0.0.0", "end 0.0.0.0", "start 127.0.0.1", "end 127.0.0.1"]);
    expect(network.store.policy).toEqual({ enabled: true, loopbackOnly: true });
    expect(listener.host).toBe("127.0.0.1");

    listener.rebind = async (host: BindHost) => {
      if (host === "0.0.0.0") throw new Error("EADDRINUSE");
      listener.host = host;
    };
    await expect(network.update({ loopbackOnly: false })).rejects.toThrow("EADDRINUSE");
    expect(network.store.policy).toEqual({ enabled: true, loopbackOnly: true });
    expect(network.desiredHost()).toBe(listener.host);
  });
});
