import {
  type FactoryHoldBy,
  type FactoryItem,
  type FactoryItemStage,
  type FactoryLoop,
  factoryStopReason,
} from "@agent-rishi/contracts";
import type { FactoryContext } from "./context";
import { closeInboxFor } from "./merge";
import { failItem } from "./outcomes";
import { isBusy } from "./sessions";

/** The steps that end an item as a stop made on purpose (`progress.ts`, `verify.ts`). */
const STOPPABLE: FactoryItemStage[] = ["building", "verifying"];

/**
 * Stops made on purpose (§10.1, Held work). `stop_session` with a reason on a factory item's
 * builder or reviewer records the stop on the item (`FactoryItem.stop`) before the session stops.
 * When the building or verifying step then finds that session stopped, the item stops as that
 * call: failed with the reason ("Stopped by the PM: waiting on #412"), outside the failure streak
 * that pauses the loop (`countsAsFailure: false`), with no notice back to the PM, who made the
 * call, and it doesn't come back by itself (only Retry runs it again). A stop without a reason
 * still counts as a failure, as before. An automatic revert is never stopped this way: the default
 * branch stays red until it lands, and its own rules handle it.
 */

/**
 * Record a stop on the item whose current builder or reviewer `sessionId` is; with `stop` null,
 * clear a stop recorded for that session (the session couldn't be stopped). Null when the session
 * works on no factory item, on an automatic revert, or on an item past building and verifying
 * (merged and watched: nothing would read the stop, and it mustn't outlive the call).
 */
export function recordStop(
  ctx: FactoryContext,
  projectId: string,
  sessionId: string,
  stop: { reason: string; by: FactoryHoldBy } | null,
): FactoryItem | null {
  const item = ctx.store.itemForSession(projectId, sessionId);
  if (!item || item.source === "revert") return null;
  if (!stop) {
    if (item.stop?.sessionId !== sessionId) return item;
    return ctx.store.updateItem(item.id, (i) => ({ ...i, stop: null }), { touch: false });
  }
  if (!STOPPABLE.includes(item.stage)) return null;
  const at = ctx.now().toISOString();
  return ctx.store.updateItem(
    item.id,
    (i) => ({ ...i, stop: { sessionId, reason: stop.reason, by: stop.by, at } }),
    { touch: false },
  );
}

/**
 * The item as stored now. A tick reads a stage's items once and then steps through them in turn,
 * so a stop recorded since (just before its session stopped) is only on the stored item: read
 * from the tick's copy, the stopped session would count as a failure.
 */
function stored(ctx: FactoryContext, item: FactoryItem): FactoryItem {
  return ctx.store.item(item.id) ?? item;
}

/** Whether the item's current builder or reviewer was stopped by the stop recorded on it. */
export function stoppedOnPurpose(ctx: FactoryContext, item: FactoryItem): boolean {
  if (item.source === "revert") return false;
  const current = stored(ctx, item);
  const id = current.stop?.sessionId;
  if (!id) return false;
  if (id !== current.builderSessionId && id !== current.reviewerSessionId) return false;
  return ctx.repo.find(id)?.session.status === "stopped";
}

/** The item ends as the stop's call: failed with its reason, never counted towards the pause. */
export function endStopped(ctx: FactoryContext, loop: FactoryLoop, item: FactoryItem): FactoryLoop {
  const current = stored(ctx, item);
  const stop = current.stop;
  const owners = ctx.repo
    .list({ projectId: current.projectId, role: "agent" })
    .filter(
      (session) =>
        session.id !== stop?.sessionId &&
        session.id !== current.builderSessionId &&
        session.id !== current.reviewerSessionId &&
        isBusy(session) &&
        (session.workKey === current.workKey ||
          (current.pr && session.pr?.url === current.pr.url) ||
          (current.issue && session.issue?.url === current.issue.url)),
    );
  if (owners.length === 1) {
    ctx.store.updateItem(current.id, (i) => ({
      ...i,
      replacementSessionId: owners[0]?.id,
    }));
  }
  closeInboxFor(ctx, item.id, "Stopped on purpose");
  const reason = stop ? factoryStopReason(stop) : "Stopped on purpose";
  ctx.log?.(`factory: ${item.id}: ${reason}`);
  return failItem(ctx, loop, item, reason, { countsAsFailure: false, notify: false });
}

/** Whether a failed item ended by a stop made on purpose: it never goes back by itself. */
export function endedByStop(item: FactoryItem): boolean {
  return (
    item.stage === "failed" && item.stop !== null && item.reason === factoryStopReason(item.stop)
  );
}
