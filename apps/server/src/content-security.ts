import { uiContentSecurityPolicy } from "@agent-rishi/contracts";
import type { MiddlewareHandler } from "hono";

const CSP = "content-security-policy";

/**
 * Sends the UI's Content-Security-Policy (§15) with every response that doesn't set a stricter
 * one of its own (stored artifacts, remote images): the UI, the "Agent Rishi is locked" page and
 * the API. Images then load only from Agent Rishi, `data:` and `blob:`, whatever Markdown asks for.
 */
export function contentSecurityPolicy(): MiddlewareHandler {
  return async (c, next) => {
    await next();
    if (c.req.header("upgrade") || c.res.headers.has(CSP)) return;
    try {
      c.res.headers.set(CSP, uiContentSecurityPolicy(c.req.header("host")));
    } catch {
      // A response passed through with immutable headers is never a page of the UI.
    }
  };
}
