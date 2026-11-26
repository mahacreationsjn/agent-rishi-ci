import { type FactoryItemCost, ITEM_BUDGET_WARN, itemBudgetUsed } from "@agent-rishi/contracts";
import { money, tokens } from "@/components/usage/format";

/**
 * A factory work item's cost (§10.1, §12.6) as the Factory view's cards, its side sheet and the
 * item page show it: the same figures and honest labels as the usage reports.
 */

/** The item has usage to show (an agent worked on it). */
export function hasCost(cost: FactoryItemCost | null | undefined): cost is FactoryItemCost {
  return Boolean(cost && cost.turns > 0);
}

/** No turn had a reported cost or a price to estimate one from. */
function notPriced(c: FactoryItemCost): boolean {
  return c.turns > 0 && c.unpricedTurns === c.turns;
}

/** "≈ $12.40" for estimates, "$3.10" when reported, "Not priced" when nothing could be. */
export function costText(c: FactoryItemCost): string {
  return notPriced(c) ? "Not priced" : money(c.usd, c.estimatedUsd > 0);
}

/**
 * What kind of figure it is and what it covers: "API-equivalent cost so far (estimated from
 * list prices) · 3 sessions · 42 turns · 4.1M tokens".
 */
export function costTitle(c: FactoryItemCost): string {
  if (notPriced(c)) {
    return `Not priced: no price for these models and no reported cost · ${tokens(c.tokens)} tokens`;
  }
  const kind = c.apiEquivalent ? "API-equivalent cost so far" : "Cost so far";
  const label = c.estimatedUsd > 0 ? `${kind} (estimated from list prices)` : kind;
  return [
    label,
    `${c.sessions} session${c.sessions === 1 ? "" : "s"}`,
    `${c.turns} turn${c.turns === 1 ? "" : "s"}`,
    `${tokens(c.tokens)} tokens`,
    c.unpricedTurns > 0 ? `${c.unpricedTurns} turns not priced` : null,
  ]
    .filter(Boolean)
    .join(" · ");
}

/** "≈ $12.40 · 4.1M tokens" for the item's Cost fact. */
export function costFact(c: FactoryItemCost): string {
  return `${costText(c)} · ${tokens(c.tokens)} tokens`;
}

/**
 * Where the item stands against the per-item cap, since it was last retried: "$9.30 of
 * $15.00", "1.2M of 2M tokens" or both; null without a cap.
 */
export function capText(c: FactoryItemCost | null | undefined): string | null {
  const cap = c?.cap;
  if (!cap) return null;
  return [
    cap.usd !== null ? `${money(cap.spentUsd)} of ${money(cap.usd)}` : null,
    cap.tokens !== null ? `${tokens(cap.spentTokens)} of ${tokens(cap.tokens)} tokens` : null,
  ]
    .filter(Boolean)
    .join(" · ");
}

/** The item is close to (or at) its per-item cap: the Factory view marks its cost. */
export function nearCap(c: FactoryItemCost | null | undefined): boolean {
  const used = itemBudgetUsed(c?.cap ?? null);
  return used !== null && used >= ITEM_BUDGET_WARN;
}
