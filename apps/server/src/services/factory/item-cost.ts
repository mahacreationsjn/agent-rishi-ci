import {
  type BillingMode,
  type CapSpend,
  type CostSource,
  type FactoryItem,
  type FactoryItemCost,
  type FactoryLimits,
  hasItemBudget,
  type Session,
} from "@agent-rishi/contracts";
import type { FactoryContext } from "./context";

/**
 * What factory work items cost (§10.1, §12.6): every agent session that worked on an item, from
 * the usage ledger, priced and labelled as the usage reports are. Also the spend that counts
 * toward the per-item cap (`item-budget.ts`).
 */

/** One priced ledger turn, as the usage service reads it (`UsageService.turnsOf`). */
export interface LedgerTurn {
  sessionId: string;
  provider: string;
  ts: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  costUsd: number;
  costSource: CostSource;
}

const tokensOf = (t: LedgerTurn) =>
  t.inputTokens + t.outputTokens + t.cacheReadTokens + t.cacheWriteTokens;

const round = (n: number) => Math.round(n * 10_000) / 10_000;

/**
 * Work keys of the factory sessions that worked on an item: its builders (and a rebuild's), its
 * reviewers (by PR, or by item before it had one) and integrators. Items saved before
 * `sessionIds` existed find most of their history this way.
 */
export function itemWorkKeys(item: FactoryItem): string[] {
  const prs = [item.pr?.number, item.rebuiltFrom?.number].filter(
    (n): n is number => n !== undefined,
  );
  return [
    item.workKey,
    `factory:review:${item.id}`,
    ...prs.flatMap((n) => [`factory:review:${n}`, `factory:integrate:${n}`]),
  ];
}

/** Factory sessions of a project by work key. */
export function sessionsByWorkKey(sessions: Session[]): Map<string, string[]> {
  const byKey = new Map<string, string[]>();
  for (const s of sessions) byKey.set(s.workKey, [...(byKey.get(s.workKey) ?? []), s.id]);
  return byKey;
}

/**
 * Every session that worked on an item: the ones it recorded (`sessionIds`), its current ones,
 * and factory sessions found by its work keys.
 */
export function itemSessionIds(item: FactoryItem, byKey: Map<string, string[]>): Set<string> {
  const ids = new Set<string>(item.sessionIds);
  for (const id of [item.builderSessionId, item.reviewerSessionId, ...item.earlierSessionIds]) {
    if (id) ids.add(id);
  }
  for (const key of itemWorkKeys(item)) for (const id of byKey.get(key) ?? []) ids.add(id);
  return ids;
}

/** The sessions of each item, from one listing of the project's factory sessions. */
export function sessionsOfItems(
  ctx: Pick<FactoryContext, "sessions">,
  projectId: string,
  items: FactoryItem[],
): Map<string, Set<string>> {
  const byKey = sessionsByWorkKey(ctx.sessions.list(projectId));
  return new Map(items.map((i) => [i.id, itemSessionIds(i, byKey)]));
}

/** Ledger turns of these sessions, grouped by session (one ledger read). */
function turnsBySession(
  ctx: Pick<FactoryContext, "usage">,
  ids: ReadonlySet<string>,
): Map<string, LedgerTurn[]> {
  const out = new Map<string, LedgerTurn[]>();
  if (ids.size === 0 || !ctx.usage.turnsOf) return out;
  for (const t of ctx.usage.turnsOf(ids))
    out.set(t.sessionId, [...(out.get(t.sessionId) ?? []), t]);
  return out;
}

/** Spend that counts toward the per-item cap: turns since `itemBudgetSince` (all, when null). */
export function capSpendOf(turns: LedgerTurn[], since: string | null): CapSpend {
  let usd = 0;
  let tokens = 0;
  for (const t of turns) {
    if (since && t.ts < since) continue;
    usd += t.costUsd;
    tokens += tokensOf(t);
  }
  return { usd: round(usd), tokens };
}

/** An item's cost over its turns, labelled as the usage reports are. */
export function costOf(
  turns: LedgerTurn[],
  item: Pick<FactoryItem, "itemBudgetSince">,
  limits: Pick<FactoryLimits, "itemBudget">,
  billing: Record<string, BillingMode>,
): FactoryItemCost {
  let usd = 0;
  let estimatedUsd = 0;
  let tokens = 0;
  let unpricedTurns = 0;
  const sessions = new Set<string>();
  const providers = new Set<string>();
  for (const t of turns) {
    usd += t.costUsd;
    tokens += tokensOf(t);
    if (t.costSource === "estimated") estimatedUsd += t.costUsd;
    if (t.costSource === "unpriced" && tokensOf(t) > 0) unpricedTurns++;
    sessions.add(t.sessionId);
    providers.add(t.provider);
  }
  const spent = capSpendOf(turns, item.itemBudgetSince);
  return {
    usd: round(usd),
    tokens,
    estimatedUsd: round(estimatedUsd),
    unpricedTurns,
    turns: turns.length,
    sessions: sessions.size,
    apiEquivalent: [...providers].some((p) => billing[p] === "subscription"),
    cap: hasItemBudget(limits)
      ? {
          usd: limits.itemBudget.usd ?? null,
          tokens: limits.itemBudget.tokens ?? null,
          spentUsd: spent.usd,
          spentTokens: spent.tokens,
        }
      : null,
  };
}

/** The ledger turns of each item (by item id), from one read of the ledger. */
export function itemTurns(
  ctx: Pick<FactoryContext, "usage" | "sessions">,
  projectId: string,
  items: FactoryItem[],
): Map<string, LedgerTurn[]> {
  const sessionsOf = sessionsOfItems(ctx, projectId, items);
  const all = new Set([...sessionsOf.values()].flatMap((ids) => [...ids]));
  const bySession = turnsBySession(ctx, all);
  return new Map(
    items.map((i) => [
      i.id,
      [...(sessionsOf.get(i.id) ?? [])].flatMap((id) => bySession.get(id) ?? []),
    ]),
  );
}

/**
 * What each item cost (by item id), from one read of the ledger; empty when the usage service
 * can't read turns.
 */
export async function itemCosts(
  ctx: Pick<FactoryContext, "usage" | "sessions">,
  projectId: string,
  limits: Pick<FactoryLimits, "itemBudget">,
  items: FactoryItem[],
): Promise<Map<string, FactoryItemCost>> {
  if (items.length === 0 || !ctx.usage.turnsOf) return new Map();
  const turns = itemTurns(ctx, projectId, items);
  const billing = (await ctx.usage.providerBilling?.().catch(() => ({}))) ?? {};
  return new Map(items.map((i) => [i.id, costOf(turns.get(i.id) ?? [], i, limits, billing)]));
}
