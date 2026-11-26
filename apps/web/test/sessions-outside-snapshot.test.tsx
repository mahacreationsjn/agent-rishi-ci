import type { DiffResult, DiffScope, Session, Snapshot } from "@agent-rishi/contracts";
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { DiffPanel } from "@/components/workbench/diff-panel";
import type { AgentRishiClient } from "@/lib/api";
import { ApiRequestError } from "@/lib/api/http";
import { createMockClient } from "@/lib/api/mock";
import { sessionRecordKey } from "@/lib/queries";
import { FactoryViewPage } from "@/routes/factory-view";
import { InboxPage } from "@/routes/inbox";
import { status, w } from "./scene-fixtures";
import { renderWithClient } from "./utils";

/**
 * #372: the snapshot carries only the recently archived sessions (#350), so a session archived
 * a day or two ago drops out of it. The views that looked a session up only in the snapshot lost
 * their features for it, without an error. Each one here has the server know a session the
 * snapshot no longer carries.
 */

const toast = vi.hoisted(() =>
  Object.assign(vi.fn(), { success: vi.fn(), error: vi.fn(), warning: vi.fn() }),
);
vi.mock("sonner", () => ({ toast }));

vi.mock("@pierre/diffs/react", () => ({
  PatchDiff: (props: { patch: string; renderHeaderMetadata: () => ReactNode }) => (
    <div data-testid="patch">
      {props.renderHeaderMetadata()}
      <pre>{props.patch}</pre>
    </div>
  ),
}));

afterEach(() => {
  vi.clearAllMocks();
  vi.restoreAllMocks();
  localStorage.clear();
});

/** The mock world, with `ids` gone from the snapshot; the server still knows them. */
async function withoutInSnapshot(client: AgentRishiClient, ids: string[]) {
  const snap = await client.getSnapshot();
  vi.spyOn(client, "getSnapshot").mockResolvedValue({
    ...snap,
    sessions: snap.sessions.filter((s) => !ids.includes(s.id)),
  });
}

/** The rendered inbox entry of an item. */
async function entry(id: string): Promise<HTMLElement> {
  return waitFor(() => {
    const el = document.getElementById(`inbox-item-${id}`);
    if (!el) throw new Error(`no entry ${id}`);
    return el;
  });
}

describe("Run failed actions for a session outside the snapshot", () => {
  it("turns Retry off while its provider can't run, and offers the hand-off", async () => {
    // `ib-failed` is a failed run of `s-deps`, a Codex session; Codex isn't signed in.
    const client = createMockClient();
    await withoutInSnapshot(client, ["s-deps"]);
    const retry = vi.spyOn(client, "retryInbox");
    renderWithClient(<InboxPage />, client, { withRouter: true });
    const codex = await entry("ib-failed");
    await waitFor(() =>
      expect(within(codex).getByRole("button", { name: /Retry/ })).toHaveProperty("disabled", true),
    );
    expect(within(codex).getByTestId("retry-blocked").textContent).toMatch(
      /Codex is not signed in/,
    );
    expect(
      within(codex).getByRole("button", { name: /Continue on another provider/ }),
    ).toBeTruthy();
    fireEvent.click(within(codex).getByRole("button", { name: /Retry/ }));
    expect(retry).not.toHaveBeenCalled();
  });

  it("offers the hand-off when a retry is refused because the provider can't run", async () => {
    const client = createMockClient();
    await withoutInSnapshot(client, ["s-a11y"]);
    vi.spyOn(client, "retryInbox").mockRejectedValueOnce(
      new ApiRequestError(409, "provider_unavailable", "Claude Code hit its usage limit"),
    );
    const { queryClient } = renderWithClient(<InboxPage />, client, { withRouter: true });
    const claude = await entry("ib-failed-a11y");
    // The view looks the session up by id, so the toast can offer the hand-off.
    await waitFor(() => expect(queryClient.getQueryData(sessionRecordKey("s-a11y"))).toBeTruthy());
    fireEvent.click(within(claude).getByRole("button", { name: /Retry/ }));
    await waitFor(() => expect(toast.error).toHaveBeenCalled());
    expect(toast.error).toHaveBeenCalledWith(
      "Retry failed",
      expect.objectContaining({
        action: expect.objectContaining({ label: "Continue on another provider" }),
      }),
    );
  });
});

const at = "2026-11-14T10:00:00.000Z";
const path = "src/cart.ts";
const patch = `diff --git a/${path} b/${path}\n--- a/${path}\n+++ b/${path}\n@@ -1 +1 @@\n-a\n+b\n`;
const session = (id: string, more: Partial<Session>) =>
  ({
    id,
    role: "agent",
    status: "idle",
    provider: "claude",
    projectId: "p1",
    createdAt: at,
    ...more,
  }) as Session;

describe("Compare with, when the source is outside the snapshot", () => {
  it("lists the archived source", async () => {
    const source = session("s-source", { title: "Cart totals", archivedAt: at });
    const fork = session("s-fork", {
      title: "Cart totals, another way",
      forkedFrom: { sessionId: "s-source", checkpoint: 2 },
    });
    const client: AgentRishiClient = {
      ...createMockClient(),
      // The snapshot no longer carries the archived source; the server still has it.
      getSnapshot: async () => ({ sessions: [fork], projects: [] }) as unknown as Snapshot,
      getSessions: async (ids) => [source, fork].filter((s) => ids.includes(s.id)),
      gitStatus: async () => ({ branch: "b", baseBranch: "main", ahead: 0, behind: 0, files: [] }),
      getDiff: async (_id: string, scope: DiffScope): Promise<DiffResult> => ({
        scope,
        files: [{ path, change: "modify" as const, additions: 1, deletions: 1, patch }],
        turns: [],
      }),
    };
    renderWithClient(<DiffPanel sessionId="s-fork" />, client, { withRouter: true });
    await screen.findByTestId("patch");
    fireEvent.keyDown(await screen.findByRole("button", { name: /All changes/ }), {
      key: "Enter",
    });
    expect(await screen.findByRole("menuitem", { name: /Cart totals\s*source/ })).toBeTruthy();
  });
});

describe("Factory view cards whose sessions are outside the snapshot", () => {
  beforeAll(() => {
    // jsdom has no 2D canvas; the scene draws nothing without one.
    HTMLCanvasElement.prototype.getContext = (() => null) as never;
    // The PM chat scrolls its messages; jsdom doesn't.
    if (!Element.prototype.scrollTo) Element.prototype.scrollTo = () => {};
  });

  // An item watched on the default branch after its merge: its builder and reviewer are
  // archived, and the snapshot no longer carries them.
  const f = status({
    projectId: "p-storefront",
    mode: "software_factory",
    scout: null,
    recent: [
      w("merged-7", 7, {
        stage: "watching",
        step: "merge",
        sessionId: "s-checkout",
        reviewerSessionId: "s-a11y",
        mergedAt: new Date().toISOString(),
        stepSince: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      }),
    ],
  });

  async function renderView() {
    // A wide screen.
    vi.spyOn(window, "matchMedia").mockImplementation(
      (query) =>
        ({
          matches: true,
          media: query,
          addEventListener: () => {},
          removeEventListener: () => {},
        }) as unknown as MediaQueryList,
    );

    const client = createMockClient();
    await withoutInSnapshot(client, ["s-checkout", "s-a11y"]);
    // Archived when the item merged: done, keeping its last progress line.
    const lookup = client.getSessions;
    const archivedAt = new Date().toISOString();
    vi.spyOn(client, "getSessions").mockImplementation(async (ids) =>
      (await lookup(ids)).map((s) => ({ ...s, status: "completed" as const, archivedAt })),
    );
    vi.spyOn(client.factory, "status").mockResolvedValue(f);
    renderWithClient(<FactoryViewPage projectId="p-storefront" />, client, { withRouter: true });
    return client;
  }

  it("shows the session's last progress line on the board card", async () => {
    await renderView();
    await waitFor(() =>
      expect(screen.getByRole("button", { name: /^#7 Item 7/ }).textContent).toContain(
        "Fix verified with 50 repeats; waiting to push",
      ),
    );
  });
});
