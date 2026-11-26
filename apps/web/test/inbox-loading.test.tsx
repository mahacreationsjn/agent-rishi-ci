import type { ConflictRecord, Snapshot } from "@agent-rishi/contracts";
import { act, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { createMockClient } from "@/lib/api/mock";
import { InboxPage } from "@/routes/inbox";
import { renderWithClient } from "./utils";

/**
 * A direct load of /inbox (a notification's Open, a deep link, a bookmark) renders before the
 * app snapshot arrives. Until it does, the inbox must not claim that nothing needs you (#400).
 */

/** A promise and the function that settles it, for holding a request open. */
function held<T>() {
  let release: (value: T) => void = () => {};
  const promise = new Promise<T>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}

/** Let the router mount the page and settled queries render; held requests stay pending. */
async function settle() {
  await screen.findByText("Inbox");
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

describe("inbox while the snapshot is loading", () => {
  it("doesn't say you're all caught up before the snapshot has loaded", async () => {
    const base = createMockClient();
    const snapshot = await base.getSnapshot();
    expect(snapshot.inbox.some((i) => i.status === "open")).toBe(true);

    const pending = held<Snapshot>();
    const client = Object.assign(base, { getSnapshot: () => pending.promise });
    renderWithClient(<InboxPage />, client, { withRouter: true });
    await settle();

    expect(screen.queryByText("You're all caught up")).toBeNull();
    expect(screen.queryByText("0 waiting on you")).toBeNull();
    expect(screen.getByRole("status", { name: "Loading the inbox" })).toBeTruthy();

    // Once the snapshot lands, the waiting items show.
    await act(async () => pending.release(snapshot));
    await screen.findByText("Security audit (Billing API) flagged 2 medium findings");
    expect(screen.queryByText("You're all caught up")).toBeNull();
    expect(screen.queryByRole("status", { name: "Loading the inbox" })).toBeNull();
  });

  it("waits for the conflicts too before saying you're all caught up", async () => {
    const base = createMockClient();
    const snapshot: Snapshot = { ...(await base.getSnapshot()), inbox: [] };
    const conflicts = held<ConflictRecord[]>();
    const client = Object.assign(base, {
      getSnapshot: async () => snapshot,
      listConflicts: () => conflicts.promise,
    });
    renderWithClient(<InboxPage />, client, { withRouter: true });
    await settle();

    expect(screen.queryByText("You're all caught up")).toBeNull();
    expect(screen.getByRole("status", { name: "Loading the inbox" })).toBeTruthy();
    // No count yet beside the loading rows: All counts conflicts too.
    expect(screen.queryByText("0 waiting on you")).toBeNull();
    expect(screen.getByText("Loading…")).toBeTruthy();

    await act(async () => conflicts.release([]));
    await screen.findByText("You're all caught up");
    expect(screen.getByText("0 waiting on you")).toBeTruthy();
  });
});
