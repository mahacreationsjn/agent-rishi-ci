import type { BillingMode, SetupStatus } from "@agent-rishi/contracts";
import { isProviderCheck } from "../setup/provider-checks";

/**
 * How a login is paid for, from the auth method a CLI reports: API keys and console
 * accounts pay per token; claude.ai, ChatGPT and Cursor logins are subscriptions (a Cursor
 * API key bills the Cursor plan too: `cursor_key`). Gemini CLI's Google login
 * (`oauth-personal`) is a subscription, its `gemini-api-key` and `vertex-ai` pay per token;
 * Antigravity CLI reports the same names. Pure.
 */
export function billingFromAuthMethod(authMethod: string | null): BillingMode {
  if (!authMethod) return "unknown";
  const m = authMethod.toLowerCase();
  if (/api[\s_-]?key|apikey|console|bedrock|vertex/.test(m)) return "api";
  if (/claude\.ai|chatgpt|cursor|oauth|subscription|\bpro\b|\bmax\b|team|enterprise/.test(m)) {
    return "subscription";
  }
  return "unknown";
}

/**
 * Billing mode per provider id from setup detection (`claude`, `codex`, `opencode`, `cursor`,
 * `gemini`, `antigravity`), from the runner's detection that setup shows. OpenCode reports how its
 * providers are connected (`credentials`, `environment`, `free`), which says nothing of billing.
 */
export function billingFromSetup(status: SetupStatus): Record<string, BillingMode> {
  const out: Record<string, BillingMode> = {};
  for (const check of status.checks) {
    if (isProviderCheck(check.id)) {
      out[check.id] = check.loggedIn ? billingFromAuthMethod(check.authMethod) : "unknown";
    }
  }
  return out;
}
