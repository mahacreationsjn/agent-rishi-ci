import type { ProviderInfo, ProviderSwitchData } from "@agent-rishi/contracts";
import { localDateTime } from "../automations/cron";
import { autoOrder } from "../sessions/provider-order";

/**
 * A role on a fallback provider (§8.1, `settings.providers.autoSwitchOnLimit`): the orchestrator
 * or a PM whose provider hit its usage limit runs on another one until the limit resets. Kept
 * with the fallback session's start metadata (`StoredStartMeta.fallback`), so a restart keeps it.
 */
export interface RoleFallback {
  /** The provider the role ran on when it first hit a limit: where it goes back to. */
  home: string;
  /**
   * When `home`'s limit resets. Null: the provider didn't say, so the role stays on the fallback
   * until its provider setting is changed.
   */
  until: string | null;
  /**
   * Providers that hit their limit since the role left `home`, with the time each is skipped
   * until, so a second limit never moves the role onto a provider still at its own.
   */
  limited: Record<string, string>;
}

/** How long after a usage limit resets the role goes back (as agent sessions' retries wait). */
export const LIMIT_RESET_MARGIN_MS = 60_000;
/** A limit without a reset time keeps its provider out of the fallbacks for this long. */
const UNKNOWN_RESET_MS = 60 * 60_000;

/** Whether the limit that moved the role away has reset, so its next turn goes back. */
export function limitReset(fallback: RoleFallback, now: number): boolean {
  if (!fallback.until) return false;
  const at = Date.parse(fallback.until);
  return Number.isFinite(at) && at + LIMIT_RESET_MARGIN_MS <= now;
}

/**
 * The fallback state after `provider` hit its limit (until `retryAt`, when it said), given the
 * state of the session it happened on (null when that one ran on the role's own provider). The
 * provider that just failed is always skipped for a while, also when the reset time it gave has
 * already passed (a stale one), so the role never "falls back" onto the provider at its limit.
 */
export function afterLimit(
  earlier: RoleFallback | null,
  provider: string,
  retryAt: string | null,
  now: number,
): RoleFallback {
  const known = retryAt && Number.isFinite(Date.parse(retryAt)) ? retryAt : null;
  const limited: Record<string, string> = {};
  for (const [id, until] of Object.entries(earlier?.limited ?? {})) {
    if (Date.parse(until) > now) limited[id] = until;
  }
  const ahead = known && Date.parse(known) > now ? known : null;
  limited[provider] = ahead ?? new Date(now + UNKNOWN_RESET_MS).toISOString();
  return { home: earlier?.home ?? provider, until: earlier ? earlier.until : known, limited };
}

/**
 * The provider a role moves to when its own is at its usage limit, or null when none can take
 * over. In order: `preferred` (the role's provider setting, then the defaults), then every other
 * provider the runner loaded, in the order Auto tries them. Only a provider that is loaded, can
 * run read-only (`capabilities.readOnly`: the roles never write), is ready (installed and signed
 * in) and isn't at a limit of its own. Never decided by a provider's id. Pure.
 */
export function pickFallback(opts: {
  preferred: readonly (string | null | undefined)[];
  /** The providers the home runner loaded. */
  providers: readonly ProviderInfo[];
  /** Ids of the providers that can run new work now; null: not known, so every loaded one. */
  ready: ReadonlySet<string> | null;
  limited: Record<string, string>;
  now: number;
}): string | null {
  const loaded = new Map(opts.providers.map((p) => [p.id, p]));
  const usable = (id: string) => {
    const until = opts.limited[id];
    if (until && Date.parse(until) > opts.now) return false;
    return loaded.get(id)?.capabilities.readOnly === true && (opts.ready?.has(id) ?? true);
  };
  const order = [
    ...opts.preferred.filter((id): id is string => !!id && id !== "auto"),
    ...autoOrder([...loaded.keys()]),
  ];
  return order.find(usable) ?? null;
}

/** "Orchestrator" or "PM", to start a sentence about the role. */
export const roleName = (role: "orchestrator" | "pm") => (role === "pm" ? "PM" : "Orchestrator");

/**
 * The line shown in the role's chat and the inbox. `names` are the providers' names for people
 * (`from`, `to` and, for a reset, the provider whose limit reset).
 */
export function switchText(
  data: ProviderSwitchData,
  names: { from: string; to: string; home?: string },
  tz: string,
): string {
  const until = data.retryAt ? ` (until ${localDateTime(new Date(data.retryAt), tz)})` : "";
  switch (data.reason) {
    case "usage_limit":
      return `Switched from ${names.from} to ${names.to}: ${names.from} hit its usage limit${until}.`;
    case "limit_reset":
      return `Switched back from ${names.from} to ${names.to}: ${names.home ?? names.to}'s usage limit has reset.`;
    case "no_fallback":
      return `${names.from} hit its usage limit${until} and no other provider is ready to take over, so nothing was switched. Sign in to another provider (Settings → Providers), or send your message again once the limit has reset.`;
  }
}
