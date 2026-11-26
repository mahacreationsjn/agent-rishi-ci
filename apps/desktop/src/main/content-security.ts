import { uiContentSecurityPolicy } from "@agent-rishi/contracts";
import type { OnHeadersReceivedListenerDetails, Session } from "electron";
import { isServerUrl } from "./security";

/** The part of an Electron session the window's policy uses (a fake one in tests). */
export interface PolicySession {
  webRequest: Pick<Session["webRequest"], "onHeadersReceived">;
}

/**
 * The window's Content-Security-Policy (§15, §17): every response from the server's origin
 * carries the UI's policy, so a server that sends none (an older one) still can't let
 * Markdown load remote images. A policy the server sent stays as well: browsers enforce every
 * policy they get, so a stricter one (stored artifacts) stays strict. Other origins are left
 * alone; the native browser views use their own partitions anyway.
 */
export function applyContentSecurityPolicy(
  session: PolicySession,
  serverOrigin: () => string | null,
): void {
  session.webRequest.onHeadersReceived((details, callback) => {
    callback({ responseHeaders: withPolicy(details, serverOrigin()) });
  });
}

function withPolicy(
  details: Pick<OnHeadersReceivedListenerDetails, "url" | "responseHeaders">,
  origin: string | null,
): Record<string, string[]> | undefined {
  const headers = details.responseHeaders;
  if (!origin || !isServerUrl(details.url, origin)) return headers;
  const policy = uiContentSecurityPolicy(new URL(origin).host);
  const name =
    Object.keys(headers ?? {}).find((key) => key.toLowerCase() === "content-security-policy") ??
    "Content-Security-Policy";
  const sent = headers?.[name] ?? [];
  return { ...headers, [name]: sent.includes(policy) ? sent : [...sent, policy] };
}
