import { uiContentSecurityPolicy } from "@agent-rishi/contracts";
import { describe, expect, it } from "vitest";
import { applyContentSecurityPolicy, type PolicySession } from "../src/main/content-security";

type Listener = Parameters<PolicySession["webRequest"]["onHeadersReceived"]>[0];
type Details = Parameters<Exclude<Listener, null>>[0];

/** A session that records the listener, and a way to run a response through it like Electron. */
function fakeSession() {
  let listener: Listener = null;
  const session = {
    webRequest: {
      onHeadersReceived: (...args: unknown[]) => {
        listener = args.at(-1) as Listener;
      },
    },
  } as unknown as PolicySession;
  const respond = (url: string, responseHeaders?: Record<string, string[]>) =>
    new Promise<Record<string, string[]> | undefined>((resolve) => {
      if (!listener) throw new Error("no onHeadersReceived listener");
      listener({ url, responseHeaders } as Details, (response) =>
        resolve(response.responseHeaders as Record<string, string[]> | undefined),
      );
    });
  return { session, respond };
}

describe("desktop window Content-Security-Policy (#317)", () => {
  const origin = "http://127.0.0.1:4317";
  const policy = uiContentSecurityPolicy("127.0.0.1:4317");

  it("sets the UI's policy on the window's session for the server's responses", async () => {
    const { session, respond } = fakeSession();
    applyContentSecurityPolicy(session, () => origin);
    const headers = await respond(`${origin}/sessions/s1`, { "Content-Type": ["text/html"] });
    expect(headers).toEqual({ "Content-Type": ["text/html"], "Content-Security-Policy": [policy] });
    expect(policy).toMatch(/img-src 'self' data: blob:/);
  });

  it("keeps a policy the server sent, and never touches other origins", async () => {
    const { session, respond } = fakeSession();
    let current: string | null = null;
    applyContentSecurityPolicy(session, () => current);
    const other = { "content-type": ["image/png"] };
    // Before the server is known nothing is changed.
    expect(await respond(`${origin}/`, other)).toEqual(other);
    current = origin;
    expect(await respond("https://example.com/x.png", other)).toEqual(other);
    const strict = "default-src 'none'; sandbox";
    expect(
      await respond(`${origin}/api/artifacts/a1`, { "content-security-policy": [strict] }),
    ).toEqual({ "content-security-policy": [strict, policy] });
    expect(await respond(`${origin}/`, { "content-security-policy": [policy] })).toEqual({
      "content-security-policy": [policy],
    });
  });
});
