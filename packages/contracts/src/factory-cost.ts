import { z } from "zod";
import type { FactoryLimits } from "./factory";

/**
 * What a factory work item cost (§10.1, §12.6): every agent session that worked on it (builders,
 * reviewers, integrators, earlier attempts), from the usage ledger, priced and labelled as the
 * usage reports are. Computed when read, never stored with the item.
 */

/** Spend toward the per-item cap (`FactoryLimits.itemBudget`), since the item was last retried. */
export const FactoryItemCap = z.object({
  /** The cap in USD; null when only a token cap is set. */
  usd: z.number().positive().nullable(),
  /** The cap in tokens; null when only a USD cap is set. */
  tokens: z.int().positive().nullable(),
  /** USD counted toward it (since `FactoryItem.itemBudgetSince`). */
  spentUsd: z.number().nonnegative(),
  /** Tokens counted toward it. */
  spentTokens: z.int().nonnegative(),
});
export type FactoryItemCap = z.infer<typeof FactoryItemCap>;

/** An item's cost so far, over all its sessions and all time (not just today). */
export const FactoryItemCost = z.object({
  /** Reported cost where the provider gave one, else estimated from the price table. */
  usd: z.number().nonnegative(),
  /** Input, output, cache-read and cache-write tokens. */
  tokens: z.int().nonnegative(),
  /** Part of `usd` estimated from the price table rather than reported. */
  estimatedUsd: z.number().nonnegative(),
  /** Turns with no reported cost and no price to estimate one from. */
  unpricedTurns: z.int().nonnegative(),
  turns: z.int().nonnegative(),
  /** Sessions with usage. */
  sessions: z.int().nonnegative(),
  /**
   * A provider of these sessions is a subscription login: the figure is what the same work would
   * cost on API credits, not a bill (§12.6).
   */
  apiEquivalent: z.boolean().default(false),
  /** Where the item stands against the per-item cap; null when no cap is set. */
  cap: FactoryItemCap.nullable().default(null),
});
export type FactoryItemCost = z.infer<typeof FactoryItemCost>;
export type FactoryItemCostInit = z.input<typeof FactoryItemCost>;

/** True when the limits carry a per-item spend cap. */
export function hasItemBudget(limits: Pick<FactoryLimits, "itemBudget">): boolean {
  return limits.itemBudget.usd !== undefined || limits.itemBudget.tokens !== undefined;
}

/** Spend counted toward a cap: USD and tokens. */
export interface CapSpend {
  usd: number;
  tokens: number;
}

/**
 * Why an item's spend reached the per-item cap ("$5.10 of $5.00"), or null while it is under
 * the cap or none is set.
 */
export function itemBudgetReached(
  spend: CapSpend,
  limits: Pick<FactoryLimits, "itemBudget">,
): string | null {
  const { usd, tokens } = limits.itemBudget;
  if (usd !== undefined && spend.usd >= usd) {
    return `$${spend.usd.toFixed(2)} of $${usd.toFixed(2)}`;
  }
  if (tokens !== undefined && spend.tokens >= tokens) {
    return `${spend.tokens.toLocaleString("en-US")} of ${tokens.toLocaleString("en-US")} tokens`;
  }
  return null;
}

/**
 * The share of the cap used (0..1+, the larger of USD and tokens); null without a cap. The
 * Factory view warns from `ITEM_BUDGET_WARN`.
 */
export function itemBudgetUsed(cap: FactoryItemCap | null): number | null {
  if (!cap) return null;
  const shares = [
    cap.usd ? cap.spentUsd / cap.usd : null,
    cap.tokens ? cap.spentTokens / cap.tokens : null,
  ].filter((s): s is number => s !== null);
  return shares.length > 0 ? Math.max(...shares) : null;
}

/** Share of the per-item cap from which the Factory view marks an item's cost. */
export const ITEM_BUDGET_WARN = 0.8;
