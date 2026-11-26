import type { SpecApproval } from "@agent-rishi/contracts";
import { ApiRequestError } from "../http";
import type { MockWorld } from "./world";

/**
 * The mock's spec approval (§10.1) beyond the fixtures: a decision on a spec revised since the
 * page showed it is refused, as the server does (409 `spec_changed`), and `?mock-spec-revised`
 * lets you try that.
 */

/** The spec inbox item of a factory item. */
export const specInboxId = (itemId: string) => `inbox:factory-spec:${itemId}`;

/** The mock's feature whose spec waits for approval (`fixtures/ops.ts`). */
const DEMO = { projectId: "p-storefront", itemId: "fw-14" };

/** What a person asked for in another tab, and the agent's revised spec. */
const ASKED = "Also take store credit";
/** Items whose spec the agent revised (`?mock-spec-revised`). */
const revised = new Set<string>();
export const isRevised = (itemId: string) => revised.has(itemId);
export const REVISED_DETAILS = [
  "A **Gift card or store credit** field under the order summary, with an Apply button.",
  "",
  "- A valid gift card code or store credit reduces the total by its balance, never below zero; the remainder stays on it.",
  "- An invalid or used-up code shows an inline error and changes nothing.",
  "- The order records the code or credit and the amount taken from it.",
  "- Docs: the checkout guide gets a short Gift cards and store credit section.",
].join("\n");

/** Refuse a decision made on another version than the spec on record, as the server does. */
export function assertSpecVersion(spec: SpecApproval, version: string | undefined): void {
  if (version && Date.parse(version) !== Date.parse(spec.requestedAt)) {
    throw new ApiRequestError(
      409,
      "spec_changed",
      "The spec changed since it was shown: read the revised spec, then decide again",
    );
  }
}

/**
 * Open the mock UI with `?mock-spec-revised` to try a decision on a stale spec: a few seconds
 * after it opens, the agent revises the gift card spec that waits for you (after a request for
 * changes made elsewhere), and an open item page isn't told, like a tab that missed the update.
 * Its inbox card shows the revised spec at once. Approving on the item page is then refused.
 */
export function reviseSpecLater(world: MockWorld, specs: Map<string, SpecApproval>): void {
  if (typeof window === "undefined" || !/[?&]mock-spec-revised\b/.test(window.location.search))
    return;
  window.setTimeout(() => {
    const at = new Date().toISOString();
    revised.add(DEMO.itemId);
    specs.set(DEMO.itemId, {
      state: "pending",
      requestedAt: at,
      decidedAt: null,
      by: null,
      feedback: ASKED,
      rounds: 1,
      sentAt: null,
    });
    const ask = world.snapshot.inbox.find((x) => x.id === specInboxId(DEMO.itemId));
    if (!ask) return;
    const body = (ask.body ?? "").replace(/A \*\*Gift card\*\* field[^\n]*/, REVISED_DETAILS);
    world.emitDomain({
      type: "inbox.updated",
      sessionId: null,
      payload: { item: { ...ask, status: "open", body, updatedAt: at, resolvedAt: null } },
    });
  }, 6_000);
}
