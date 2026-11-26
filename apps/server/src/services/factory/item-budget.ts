import {
  type FactoryItem,
  type FactoryItemStage,
  type FactoryLimits,
  type FactoryLoop,
  hasItemBudget,
  itemBudgetReached,
  type Project,
} from "@agent-rishi/contracts";
import type { FactoryContext } from "./context";
import { capSpendOf, itemTurns } from "./item-cost";
import { markStuck } from "./outcomes";
import { recoverable } from "./recover";
import { isBusy } from "./sessions";
import { BUILDER_FAILED_REASON } from "./turn-race";

/**
 * The per-item spend cap (`FactoryLimits.itemBudget`, §10.1). The daily budget only stops new
 * work, and work in flight moves on even while the loop is paused, so this is what keeps one
 * item from spending the day's budget by itself. Spend counts every session of the item since
 * it was last retried (`FactoryItem.itemBudgetSince`), from the usage ledger. It is checked as
 * the loop ticks, so an item can go over by what its sessions spend between two ticks.
 *
 * The cap stops agent turns, not the steps that cost nothing. Verification also holds work no
 * agent touches any more (an approved PR waiting on CI, queued to merge, brought up to date by
 * GitHub's update-branch), and a review is often the turn that goes over: such an item moves on
 * and merges, and stops only before a step that would start an agent turn
 * (`stopBeforeAgentTurn`).
 */

/** Stages whose items an agent may still work on or pick up: checked against the cap. */
const BUDGETED_STAGES: FactoryItemStage[] = ["backlog", "building", "verifying"];

/** "$5.00", "1,000,000 tokens" or both: what a retry gives an item. */
function allowance(limits: Pick<FactoryLimits, "itemBudget">): string {
  const { usd, tokens } = limits.itemBudget;
  return [
    usd !== undefined ? `$${usd.toFixed(2)}` : null,
    tokens !== undefined ? `${tokens.toLocaleString("en-US")} tokens` : null,
  ]
    .filter(Boolean)
    .join(" and ");
}

/** The reason an item over its cap fails with. */
export function itemBudgetReason(over: string): string {
  return `Spend cap reached: ${over} for this item`;
}

/**
 * Items in the queue, building or verifying (or failed, when the loop would put them back by
 * itself) that reached the per-item cap have their running sessions stopped. Those in the queue,
 * building or failed then fail as `stuck`, which reaches the inbox (a recorded decision in a
 * dark factory) and never counts toward the failure streak. Those verifying move on through the
 * steps that start no agent turn (CI, the merge queue, update-branch, the merge) and stop as
 * stuck only before one that would (`stopBeforeAgentTurn`). Runs while paused or draining too:
 * work in flight moves on then. Nothing happens without a cap.
 */
export async function enforceItemBudgets(
  ctx: FactoryContext,
  project: Project,
  loop: FactoryLoop,
): Promise<FactoryLoop> {
  const limits = project.factoryLimits;
  if (!hasItemBudget(limits) || !ctx.usage.turnsOf) return loop;
  const items = [
    ...ctx.store.items(project.id, BUDGETED_STAGES),
    // Failures the loop puts back by itself would start another turn: they stop here too.
    ...ctx.store.items(project.id, ["failed"]).filter(putBackByItself),
  ];
  if (items.length === 0) return loop;
  const turns = itemTurns(ctx, project.id, items);
  for (const item of items) {
    const spent = capSpendOf(turns.get(item.id) ?? [], item.itemBudgetSince);
    const over = itemBudgetReached(spent, limits);
    if (!over) continue;
    if (item.stage === "verifying") await stopBusySessions(ctx, item, over);
    else loop = await stopOverBudget(ctx, loop, item, over, limits);
  }
  return loop;
}

/**
 * Before a step that starts an agent turn on a verifying item (a review or re-review, a revise
 * round, a rebase or integrator, the builder brought back for the audit, an agent's commit that
 * starts CI): an item over its cap stops here instead, as stuck, its note saying why. Null when
 * it may go on.
 */
export async function stopBeforeAgentTurn(
  ctx: FactoryContext,
  project: Project,
  loop: FactoryLoop,
  item: FactoryItem,
): Promise<FactoryLoop | null> {
  const over = overItemBudget(ctx, project, item);
  if (!over) return null;
  const next = await stopOverBudget(ctx, loop, item, over, project.factoryLimits);
  ctx.store.updateItem(item.id, (i) => ({ ...i, note: overBudgetNote(over) }));
  return next;
}

/**
 * A failed item the loop puts back by itself: a failure outside its code (`recover.ts`), or a
 * builder failed by a message racing its turn (`turn-race.ts`).
 */
function putBackByItself(item: FactoryItem): boolean {
  return (
    recoverable(item) || (item.reason === BUILDER_FAILED_REASON && item.builderSessionId !== null)
  );
}

/** Stop the item's builder and reviewer sessions that are at work. */
async function stopBusySessions(ctx: FactoryContext, item: FactoryItem, over: string) {
  for (const id of new Set([item.builderSessionId, item.reviewerSessionId])) {
    const session = id ? ctx.repo.find(id)?.session : undefined;
    if (!session || !isBusy(session)) continue;
    ctx.log?.(`factory: ${item.id}: ${session.id} stopped at the item's spend cap (${over})`);
    await ctx.sessions.stop(session.id);
  }
}

async function stopOverBudget(
  ctx: FactoryContext,
  loop: FactoryLoop,
  item: FactoryItem,
  over: string,
  limits: Pick<FactoryLimits, "itemBudget">,
): Promise<FactoryLoop> {
  await stopBusySessions(ctx, item, over);
  ctx.log?.(`factory: ${item.id}: stopped at its spend cap (${over})`);
  return markStuck(
    ctx,
    loop,
    item,
    itemBudgetReason(over),
    `Raise the per-item cap in the factory settings, or retry the item to give it a fresh ${allowance(limits)}.`,
  );
}

/**
 * Why the item is over its cap, or null. A failed or escalated item over it starts no agent turn
 * (no rebase, integrator or re-review) until it is retried; a verifying one stops before its
 * next (`stopBeforeAgentTurn`).
 */
export function overItemBudget(
  ctx: FactoryContext,
  project: Project,
  item: FactoryItem,
): string | null {
  const limits = project.factoryLimits;
  if (!hasItemBudget(limits) || !ctx.usage.turnsOf) return null;
  const turns = itemTurns(ctx, project.id, [item]).get(item.id) ?? [];
  return itemBudgetReached(capSpendOf(turns, item.itemBudgetSince), limits);
}

/** The note on an item over its cap that the loop starts no agent turn for. */
export function overBudgetNote(over: string): string {
  return `${itemBudgetReason(over)}: the factory starts no agent work on it until it is retried`;
}
