import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { NetworkStatus, SignInError } from "@agent-rishi/contracts";
import { uiContentSecurityPolicy } from "@agent-rishi/contracts";
import { Hono } from "hono";
import { afterEach, beforeEach } from "vitest";
import { NetworkAccess } from "../../src/network/access";
import type { BindHost, HttpListener } from "../../src/network/listener";
import { RemoteAccessStore } from "../../src/network/store";
import { authRoutes, networkRoutes } from "../../src/routes/network";
import { errorResponse } from "../../src/routes/validate";
import { loopbackOrigins, securityMiddleware } from "../../src/security";
import { removeTree } from "./remove-tree";

/**
 * The security middleware and the sign-in routes with the peer address injected the way
 * `@hono/node-server` provides it (`env.incoming.socket.remoteAddress`), so remote requests
 * can be simulated without a second machine. `useNetworkApp()` builds a fresh app with its own
 * temp home before each test; `network`, `listener`, `app` and `dir` are live bindings to it.
 */
export const TOKEN = "t".repeat(64);
export const PORT = 4400;
export const LAN = "192.168.1.20";
export const TAILSCALE = "100.101.102.103";
export const PHONE = "192.168.1.30";
export const GOOD = "maple-river-quiet-orbit-candle";

export class FakeListener {
  host: BindHost = "127.0.0.1";
  port = PORT;
  dropped = 0;
  async rebind(host: BindHost) {
    this.host = host;
  }
  dropRemote() {
    this.dropped++;
    return 0;
  }
}

export let dir: string;
export let listener: FakeListener;
export let network: NetworkAccess;
export let app: Hono;

function build() {
  listener = new FakeListener();
  network = new NetworkAccess({
    store: new RemoteAccessStore(join(dir, "remote-access.json")),
    listener: listener as unknown as HttpListener,
    interfaces: () => ({
      "Wi-Fi": [
        {
          address: LAN,
          family: "IPv4",
          internal: false,
          netmask: "255.255.255.0",
          mac: "00:00:00:00:00:00",
          cidr: `${LAN}/24`,
        },
      ],
      Tailscale: [
        {
          address: TAILSCALE,
          family: "IPv4",
          internal: false,
          netmask: "255.192.0.0",
          mac: "00:00:00:00:00:00",
          cidr: `${TAILSCALE}/10`,
        },
      ],
    }),
    securityLogFile: join(dir, "remote-access.log"),
  });
  const ctx = {
    network,
    sessionCookie: () => `agent_rishi_session_${PORT}`,
    tokenCookie: () => `agent_rishi_token_${PORT}`,
    token: TOKEN,
  };
  const base = new Set(loopbackOrigins(PORT));
  app = new Hono();
  app.use(
    "*",
    securityMiddleware({
      token: TOKEN,
      cookieName: ctx.tokenCookie,
      allowedOrigins: () =>
        new Set([...base, ...[...network.ownHosts()].map((h) => `http://${h}:${PORT}`)]),
      publicPaths: new Set(["/api/health", "/mcp"]),
      loopbackOnlyPaths: new Set(["/mcp", "/api/browser/relay"]),
      remote: {
        enabled: () => network.enabled,
        ownHosts: () => network.ownHosts(),
        trustedOrigins: () => network.store.trustedOrigins,
        port: () => PORT,
        sessionCookieName: ctx.sessionCookie,
        verifySession: (t) => network.store.verifySession(t),
      },
    }),
  );
  const api = new Hono()
    .onError((e, c) => errorResponse(e, c))
    .get("/health", (c) => c.json({ ok: true }))
    .get("/snapshot", (c) => c.json({ snapshot: true }))
    .route("/network", networkRoutes(ctx))
    .route("/auth", authRoutes(ctx));
  app.route("/api", api);
  app.all("/mcp", (c) => c.json({ mcp: true }));
  app.get("/ws", (c) => c.text("socket"));
  app.get("/api/browser/relay", (c) => c.text("relay"));
  app.get("/csp", (c) =>
    c.text(c.req.header("host") ?? "", 200, {
      "content-security-policy": uiContentSecurityPolicy(c.req.header("host")),
    }),
  );
  app.get("*", (c) => c.html("<!doctype html><div id=root></div>"));
}

/** A fresh app and temp home for every test in the calling file. */
export function useNetworkApp(): void {
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "agent-rishi-netsec-"));
    build();
  });
  afterEach(() => removeTree(dir));
}

/** A request from `peer`, with `Host` defaulting to the address it dialled. */
export function from(
  peer: string,
  path: string,
  init: RequestInit & { host?: string } = {},
): Promise<Response> {
  const headers = new Headers(init.headers);
  if (!headers.has("host")) headers.set("host", init.host ?? `127.0.0.1:${PORT}`);
  return Promise.resolve(
    app.request(
      `http://${headers.get("host")}${path}`,
      { ...init, headers },
      { incoming: { socket: { remoteAddress: peer } } },
    ),
  );
}
export const local = (path: string, init: RequestInit & { host?: string } = {}) =>
  from("127.0.0.1", path, init);
export const phone = (path: string, init: RequestInit & { host?: string } = {}) =>
  from(PHONE, path, { host: `${LAN}:${PORT}`, ...init });
export const json = (body: unknown, extra: Record<string, string> = {}) => ({
  method: "POST",
  headers: { "content-type": "application/json", ...extra },
  body: JSON.stringify(body),
});
export const auth = { authorization: `Bearer ${TOKEN}` };
export const statusOf = async (res: Response) => (await res.json()) as NetworkStatus;
export const errorOf = async (res: Response) => (await res.json()) as SignInError;

export async function enable() {
  await network.setPassword({ password: GOOD });
  await network.setEnabled(true);
}

export async function signIn(password = GOOD, peer = PHONE): Promise<Response> {
  return from(peer, "/api/auth/sign-in", {
    host: `${LAN}:${PORT}`,
    ...json({ password }, { "user-agent": "Mozilla/5.0 (iPhone)" }),
  });
}
export const cookieOf = (res: Response) =>
  (res.headers.get("set-cookie") ?? "").split(";")[0] as string;
