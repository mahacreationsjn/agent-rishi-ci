import type { ConflictRecord, Snapshot } from "@agent-rishi/contracts";
import { act, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createMockClient } from "@/lib/api/mock";
import { conflicts as fixtureConflicts } from "@/lib/api/mock/fixtures/sessions";
import { InboxPage } from "@/routes/inbox";
import { renderWithClient } from "./utils";

/**
 * A toast's Open lands on its item: `/inbox?item=<id>` scrolls that entry into view and
 * highlights it, including a conflict, which renders from its own query (#97).
 */

/** The DOM ids `scrollIntoView` was called on. */
function watchScrolls() {
  const spy = vi.spyOn(Element.prototype, "scrollIntoView");
  return () => spy.mock.contexts.map((el) => (el as Element).id);
}

const frame = () =>
  act(async () => {
    await new Promise((resolve) => requestAnimationFrame(() => resolve(undefined)));
  });

afterEach(() => vi.restoreAllMocks());

describe("inbox focus from a toast", () => {
  it("scrolls to and highlights an inbox item", async () => {
    const scrolledTo = watchScrolls();
    renderWithClient(<InboxPage focusItemId="ib-audit" />, createMockClient(), {
      withRouter: true,
    });
    await screen.findByText("Security audit (Billing API) flagged 2 medium findings");
    await waitFor(() => expect(scrolledTo()).toContain("inbox-item-ib-audit"));
    expect(document.getElementById("inbox-item-ib-audit")?.dataset.focused).toBe("true");
  });

  it("waits for a conflict to load, then scrolls to and highlights its card", async () => {
    const scrolledTo = watchScrolls();
    let release: (list: ConflictRecord[]) => void = () => {};
    const client = Object.assign(createMockClient(), {
      listConflicts: () =>
        new Promise<ConflictRecord[]>((resolve) => {
          release = resolve;
        }),
    });
    renderWithClient(<InboxPage focusItemId="cf-audit" />, client, { withRouter: true });
    // The snapshot's items are on screen before the conflicts: nothing to scroll to yet.
    await screen.findByText("Accessibility fixes on the product page");
    await frame();
    expect(scrolledTo()).toEqual([]);

    await act(async () => release(fixtureConflicts));
    await waitFor(() => expect(scrolledTo()).toEqual(["inbox-item-cf-audit"]));
    const card = document.getElementById("inbox-item-cf-audit");
    expect(card?.dataset.focused).toBe("true");
    expect(card?.textContent).toContain("Run a security audit on Storefront");
  });

  it("scrolls to a conflict that loaded before the snapshot once the snapshot lands", async () => {
    // A direct load of /inbox?item=<conflict>: the small conflicts request answers first, while
    // the inbox still shows its loading rows, so there is no card to scroll to until then (#400).
    const scrolledTo = watchScrolls();
    const base = createMockClient();
    const snapshot = await base.getSnapshot();
    let release: (s: Snapshot) => void = () => {};
    const client = Object.assign(base, {
      getSnapshot: () =>
        new Promise<Snapshot>((resolve) => {
          release = resolve;
        }),
      listConflicts: async () => fixtureConflicts,
    });
    renderWithClient(<InboxPage focusItemId="cf-audit" />, client, { withRouter: true });
    await screen.findByRole("status", { name: "Loading the inbox" });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    await frame();
    expect(screen.getByRole("status", { name: "Loading the inbox" })).toBeTruthy();
    expect(scrolledTo()).toEqual([]);

    await act(async () => release(snapshot));
    await waitFor(() => expect(scrolledTo()).toEqual(["inbox-item-cf-audit"]));
    expect(document.getElementById("inbox-item-cf-audit")?.dataset.focused).toBe("true");
  });
});
