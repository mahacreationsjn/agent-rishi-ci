import { INBOX_BULK_MAX, type InboxItem } from "@agent-rishi/contracts";
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DismissView, UNDO_MS } from "@/components/inbox/bulk-dismiss";
import { createMockClient } from "@/lib/api/mock";
import { startRealtime } from "@/lib/realtime";
import { InboxPage } from "@/routes/inbox";
import { renderWithClient } from "./utils";

/**
 * #407: "Dismiss N" in the inbox header dismisses the notices in the current view in one
 * request, after a confirmation that names what stays, with Undo in the toast. In the mock
 * world the open items are 6 notices (a PR ready, a spot-check, 2 failed runs, an audit result,
 * a message) and 5 that wait on the user (an approval, a question, a spec, setup commands, a
 * triage decision), plus one start conflict.
 */

const toast = vi.hoisted(() =>
  Object.assign(vi.fn(), { success: vi.fn(), error: vi.fn(), warning: vi.fn() }),
);
vi.mock("sonner", () => ({ toast }));

afterEach(() => vi.clearAllMocks());

const NOTICES = [
  "ib-pr",
  "inbox:factory-spot-checks:p-storefront",
  "ib-failed-a11y",
  "ib-failed",
  "ib-audit",
  "inbox:automation-changed:project:p-storefront:nightly-notes",
];

const tab = async (name: RegExp) => fireEvent.click(await screen.findByRole("button", { name }));
const dismissButton = () => screen.queryByRole("button", { name: /^Dismiss \d+$/ });

describe("dismiss the inbox view (#407)", () => {
  it("counts what the active tab lists, and nothing that waits on the user", async () => {
    renderWithClient(<InboxPage />, createMockClient(), { withRouter: true });
    expect(await screen.findByRole("button", { name: "Dismiss 6" })).toBeTruthy();
    await tab(/^Problems/);
    expect(await screen.findByRole("button", { name: "Dismiss 2" })).toBeTruthy();
    await tab(/^Reviews/);
    expect(await screen.findByRole("button", { name: "Dismiss 4" })).toBeTruthy();
    // Everything under "Needs an answer" waits on the user: nothing to dismiss in bulk.
    await tab(/^Needs an answer/);
    await screen.findByText(/^Approvals/);
    expect(dismissButton()).toBeNull();
  });

  it("confirms what stays, dismisses in one request and undoes exactly that", async () => {
    const client = createMockClient();
    const dismiss = vi.spyOn(client, "dismissInbox");
    const restore = vi.spyOn(client, "restoreInbox");
    const { queryClient } = renderWithClient(<InboxPage />, client, { withRouter: true });
    const stop = startRealtime(client, queryClient);
    try {
      await screen.findByText("Conflicts · 1");
      fireEvent.click(await screen.findByRole("button", { name: "Dismiss 6" }));

      const dialog = await screen.findByRole("alertdialog");
      expect(within(dialog).getByText("Dismiss 6 notices?")).toBeTruthy();
      expect(dialog.textContent).toContain(
        "6 notices will be dismissed; 6 items that wait on you stay.",
      );
      const staying = within(dialog).getByTestId("dismiss-staying");
      for (const title of [
        "Already running: Run a security audit on Storefront",
        "Force push to agent-rishi/fix-checkout-flake",
        "How should failed webhooks be retried?",
        "Approve the spec: Gift cards at checkout",
        "Setup commands changed in #57: run them?",
      ]) {
        expect(within(staying).getByText(title)).toBeTruthy();
      }
      expect(within(staying).getByText("and 1 more")).toBeTruthy();
      expect(dismiss).not.toHaveBeenCalled();

      fireEvent.click(within(dialog).getByRole("button", { name: "Dismiss 6" }));
      await waitFor(() => expect(dismiss).toHaveBeenCalledTimes(1));
      expect([...(dismiss.mock.calls[0]?.[0] ?? [])].sort()).toEqual([...NOTICES].sort());

      // The notices' groups are gone (they show under "Recently resolved"); what waits on the
      // user is still listed.
      await waitFor(() => expect(screen.queryByText(/^Pull requests ready/)).toBeNull());
      for (const group of [/^Failed runs/, /^Spot-checks/, /^Automation results/, /^Messages/]) {
        expect(screen.queryByText(group)).toBeNull();
      }
      expect(screen.getByText("Approvals · 1")).toBeTruthy();
      expect(screen.getByText("Triage decisions · 1")).toBeTruthy();
      expect(screen.getByText("Conflicts · 1")).toBeTruthy();
      expect(dismissButton()).toBeNull();

      await waitFor(() => expect(toast.success).toHaveBeenCalled());
      const [message, opts] = toast.success.mock.calls[0] as [
        string,
        { action: { label: string; onClick: () => void }; duration: number },
      ];
      expect(message).toBe("Dismissed 6 notices");
      expect(opts.duration).toBe(UNDO_MS);
      expect(opts.action.label).toBe("Undo");

      opts.action.onClick();
      await waitFor(() => expect(restore).toHaveBeenCalledTimes(1));
      expect([...(restore.mock.calls[0]?.[0] ?? [])].sort()).toEqual([...NOTICES].sort());
      expect(await screen.findByText("Pull requests ready · 1")).toBeTruthy();
      expect(await screen.findByText("Failed runs · 2")).toBeTruthy();
      expect(await screen.findByRole("button", { name: "Dismiss 6" })).toBeTruthy();
      await waitFor(() => expect(toast.success).toHaveBeenCalledWith("Restored 6 notices"));
      const snapshot = await client.getSnapshot();
      expect(
        snapshot.inbox.filter((i) => NOTICES.includes(i.id)).every((i) => i.status === "open"),
      ).toBe(true);
    } finally {
      stop();
    }
  });

  it("dismisses nothing when the confirmation is cancelled", async () => {
    const client = createMockClient();
    const dismiss = vi.spyOn(client, "dismissInbox");
    renderWithClient(<InboxPage />, client, { withRouter: true });
    await tab(/^Problems/);
    fireEvent.click(await screen.findByRole("button", { name: "Dismiss 2" }));
    const dialog = await screen.findByRole("alertdialog");
    expect(dialog.textContent).toContain("2 notices will be dismissed.");
    expect(within(dialog).queryByTestId("dismiss-staying")).toBeNull();
    fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
    expect(dismiss).not.toHaveBeenCalled();
  });

  it("dismisses every notice it counts, even more than one request takes (#418)", async () => {
    const client = createMockClient();
    const dismiss = vi
      .spyOn(client, "dismissInbox")
      .mockImplementation(async (ids) => ({ dismissed: ids.length, ids, kept: 0 }));
    const restore = vi
      .spyOn(client, "restoreInbox")
      .mockImplementation(async (ids) => ({ restored: ids.length, ids }));
    renderWithClient(<DismissView items={manyNotices(INBOX_BULK_MAX + 5)} />, client);

    // What the button says it dismisses is exactly what gets sent, each request within the cap.
    const n = await confirmDismiss();
    await waitFor(() => expect(toast.success).toHaveBeenCalled());
    const sent = dismiss.mock.calls.flatMap(([ids]) => ids);
    for (const [ids] of dismiss.mock.calls) expect(ids.length).toBeLessThanOrEqual(INBOX_BULK_MAX);
    expect(new Set(sent).size).toBe(n);
    expect(sent.length).toBe(n);

    const [message, opts] = toast.success.mock.calls[0] as [
      string,
      { action: { onClick: () => void } },
    ];
    expect(message).toBe(`Dismissed ${n} notices`);

    // Undo reopens all of them, in requests the server accepts.
    opts.action.onClick();
    await waitFor(() => expect(toast.success).toHaveBeenCalledWith(`Restored ${n} notices`));
    for (const [ids] of restore.mock.calls) expect(ids.length).toBeLessThanOrEqual(INBOX_BULK_MAX);
    expect(restore.mock.calls.flatMap(([ids]) => ids).sort()).toEqual([...sent].sort());
  });

  it("keeps Undo for what went when a later request fails (#418)", async () => {
    const client = createMockClient();
    vi.spyOn(client, "dismissInbox")
      .mockImplementationOnce(async (ids) => ({ dismissed: ids.length, ids, kept: 0 }))
      .mockRejectedValueOnce(new Error("The server is not reachable"));
    const restore = vi
      .spyOn(client, "restoreInbox")
      .mockImplementation(async (ids) => ({ restored: ids.length, ids }));
    renderWithClient(<DismissView items={manyNotices(INBOX_BULK_MAX + 5)} />, client);

    await confirmDismiss();
    await waitFor(() => expect(toast.error).toHaveBeenCalled());
    expect(toast.success).not.toHaveBeenCalled();
    const [message, opts] = toast.error.mock.calls[0] as [
      string,
      { description: string; action: { onClick: () => void } },
    ];
    expect(message).toBe(`Dismissed ${INBOX_BULK_MAX} notices, then couldn't dismiss the rest`);
    expect(opts.description).toBe("The server is not reachable");
    opts.action.onClick();
    await waitFor(() =>
      expect(toast.success).toHaveBeenCalledWith(`Restored ${INBOX_BULK_MAX} notices`),
    );
    expect(restore.mock.calls.flatMap(([ids]) => ids)).toHaveLength(INBOX_BULK_MAX);
  });

  it("names what stays when a later request fails, as the success toast does (#444)", async () => {
    const client = createMockClient();
    // The server keeps 3 of the first batch because they now wait on the user (they changed after
    // the view loaded), then the second request fails.
    vi.spyOn(client, "dismissInbox")
      .mockImplementationOnce(async (ids) => ({
        dismissed: ids.length - 3,
        ids: ids.slice(3),
        kept: 3,
      }))
      .mockRejectedValueOnce(new Error("The server is not reachable"));
    renderWithClient(<DismissView items={manyNotices(INBOX_BULK_MAX + 5)} />, client);

    await confirmDismiss();
    await waitFor(() => expect(toast.error).toHaveBeenCalled());
    const [message, opts] = toast.error.mock.calls[0] as [string, { description: string }];
    expect(message).toBe(`Dismissed ${INBOX_BULK_MAX - 3} notices, then couldn't dismiss the rest`);
    expect(opts.description).toBe("The server is not reachable. 3 items that wait on you stay.");
  });

  it("says what Undo restored when a later restore request fails (#443)", async () => {
    const client = createMockClient();
    vi.spyOn(client, "dismissInbox").mockImplementation(async (ids) => ({
      dismissed: ids.length,
      ids,
      kept: 0,
    }));
    vi.spyOn(client, "restoreInbox")
      .mockImplementationOnce(async (ids) => ({ restored: ids.length, ids }))
      .mockRejectedValueOnce(new Error("The server is not reachable"));
    renderWithClient(<DismissView items={manyNotices(INBOX_BULK_MAX + 5)} />, client);

    await confirmDismiss();
    await waitFor(() => expect(toast.success).toHaveBeenCalled());
    const [, opts] = toast.success.mock.calls[0] as [string, { action: { onClick: () => void } }];
    opts.action.onClick();

    // The first request reopened INBOX_BULK_MAX notices: the toast says so, not that nothing was undone.
    await waitFor(() => expect(toast.error).toHaveBeenCalled());
    const [message, errorOpts] = toast.error.mock.calls[0] as [string, { description: string }];
    expect(message).toBe(`Restored ${INBOX_BULK_MAX} notices, then couldn't restore the rest`);
    expect(errorOpts.description).toBe("The server is not reachable");
  });

  it("says Undo failed when its first restore request fails (#443)", async () => {
    const client = createMockClient();
    vi.spyOn(client, "dismissInbox").mockImplementation(async (ids) => ({
      dismissed: ids.length,
      ids,
      kept: 0,
    }));
    vi.spyOn(client, "restoreInbox").mockRejectedValue(new Error("The server is not reachable"));
    renderWithClient(<DismissView items={manyNotices(INBOX_BULK_MAX + 5)} />, client);

    await confirmDismiss();
    await waitFor(() => expect(toast.success).toHaveBeenCalled());
    const [, opts] = toast.success.mock.calls[0] as [string, { action: { onClick: () => void } }];
    opts.action.onClick();

    await waitFor(() => expect(toast.error).toHaveBeenCalled());
    const [message, errorOpts] = toast.error.mock.calls[0] as [string, { description: string }];
    expect(message).toBe("Couldn't undo the dismiss");
    expect(errorOpts.description).toBe("The server is not reachable");
  });
});

/** `n` open notices (nothing in them waits on the user). */
function manyNotices(n: number): InboxItem[] {
  const at = new Date(0).toISOString();
  return Array.from({ length: n }, (_, i) => ({
    id: `n-${i}`,
    kind: "message",
    status: "open",
    priority: "normal",
    notify: "needs_you",
    title: `Notice ${i}`,
    body: null,
    projectId: null,
    sessionId: null,
    threadId: null,
    itemId: null,
    requestId: null,
    issue: null,
    pr: null,
    automationRunId: null,
    createdAt: at,
    updatedAt: at,
    resolvedAt: null,
    resolution: null,
  }));
}

/** Click "Dismiss N" and confirm it; answers N. */
async function confirmDismiss(): Promise<number> {
  const button = await screen.findByRole("button", { name: /^Dismiss \d+$/ });
  const n = Number(button.textContent?.match(/\d+/)?.[0]);
  fireEvent.click(button);
  const dialog = await screen.findByRole("alertdialog");
  fireEvent.click(within(dialog).getByRole("button", { name: `Dismiss ${n}` }));
  return n;
}
