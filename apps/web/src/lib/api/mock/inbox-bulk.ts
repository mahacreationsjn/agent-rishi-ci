import { type InboxItem, inboxResolvedByPm, inboxWaitsOnYou } from "@agent-rishi/contracts";
import type { AgentRishiClient } from "../client";
import type { MockWorld } from "./world";

type MockInboxBulkApi = Pick<AgentRishiClient, "dismissInbox" | "restoreInbox">;

/** Closed by a bulk dismiss (resolution `{ bulk: true }`), so Undo may reopen it. */
const bulkDismissed = (item: InboxItem) =>
  item.status === "dismissed" &&
  (item.resolution as { bulk?: unknown } | null | undefined)?.bulk === true;

/**
 * The inbox's bulk dismiss and its Undo in the mock (#407). Like the server: what waits on the
 * user stays, and Undo reopens only items a bulk dismiss (or a project manager, #673) closed.
 */
export function mockInboxBulkApi(world: MockWorld): MockInboxBulkApi {
  const update = (item: InboxItem) =>
    world.emitDomain({ type: "inbox.updated", sessionId: null, payload: { item } });
  const find = (id: string) => world.snapshot.inbox.find((i) => i.id === id);

  return {
    async dismissInbox(itemIds) {
      const ids: string[] = [];
      let kept = 0;
      for (const id of new Set(itemIds)) {
        const item = find(id);
        if (item?.status !== "open") continue;
        if (inboxWaitsOnYou(item)) {
          kept++;
          continue;
        }
        const now = new Date().toISOString();
        update({
          ...item,
          status: "dismissed",
          resolution: { bulk: true },
          resolvedAt: now,
          updatedAt: now,
        });
        ids.push(id);
      }
      return { dismissed: ids.length, ids, kept };
    },

    async restoreInbox(itemIds) {
      const ids: string[] = [];
      for (const id of new Set(itemIds)) {
        const item = find(id);
        if (!item || !(bulkDismissed(item) || inboxResolvedByPm(item))) continue;
        update({
          ...item,
          status: "open",
          resolution: null,
          resolvedAt: null,
          updatedAt: new Date().toISOString(),
        });
        ids.push(id);
      }
      return { restored: ids.length, ids };
    },
  };
}
