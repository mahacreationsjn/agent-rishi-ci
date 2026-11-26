import { InboxItem, InvestigationOutcome } from "@agent-rishi/contracts";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
  RouterProvider,
} from "@tanstack/react-router";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { OUTCOME_LABEL } from "@/components/factory/meta";
import { SPOT_CHECKS_ANCHOR } from "@/components/factory/spot-checks";
import { SpotChecksCard } from "@/components/factory/spot-checks-card";
import { InboxActions } from "@/components/inbox/inbox-actions";
import { TooltipProvider } from "@/components/ui/tooltip";
import { ClientProvider } from "@/lib/api";
import { createMockClient } from "@/lib/api/mock";
import { FactoryItemPage } from "@/routes/factory-item";
import { renderWithClient } from "./utils";

/**
 * #392: the two factory steps that ask a person to read and judge. The spec to approve came after
 * Approve, in raw Markdown; the inbox's Open spot-checks landed far from the Spot-checks list, and
 * the PR view opened from it had no way to record what you found.
 */

afterEach(() => vi.restoreAllMocks());

/** Whether `a` comes before `b` in the page. */
const before = (a: Node, b: Node) =>
  Boolean(a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING);

describe("approving a spec on the item page (#392)", () => {
  // The mock's gift card feature (`fw-14`) waits for its spec to be approved.
  const renderItem = () =>
    renderWithClient(<FactoryItemPage projectId="p-storefront" itemId="fw-14" />, undefined, {
      withRouter: true,
    });

  it("shows the spec and its acceptance criteria before the Approve button", async () => {
    renderItem();
    const approve = await screen.findByRole("button", { name: /Approve spec/ });
    const spec = await screen.findByText(/under the order summary, with an Apply button/);
    const criterion = screen.getByText("A valid code lowers the order total by up to its balance");
    // What is being approved comes first, so the person reads it before deciding.
    expect(before(spec, approve)).toBe(true);
    expect(before(criterion, approve)).toBe(true);
  });

  it("renders the spec's Markdown instead of its syntax", async () => {
    renderItem();
    await screen.findByRole("button", { name: /Approve spec/ });
    const page = document.body;
    expect(page.textContent).not.toContain("**Gift card**");
    // Bold and a list, as the Markdown component renders them.
    expect(
      within(page).getByText("Gift card", { selector: '[data-streamdown="strong"]' }),
    ).toBeTruthy();
    expect(
      within(page).getByText(/A valid code reduces the total by its balance/, { selector: "li" }),
    ).toBeTruthy();
  });

  it("says what the analysis decided in words, not as its raw outcome", async () => {
    renderItem();
    await screen.findByRole("button", { name: /Approve spec/ });
    expect(screen.queryByText(/^implement$/i)).toBeNull();
    expect(screen.getByText("Build it")).toBeTruthy();
  });

  it("has words for every outcome of the first step", () => {
    expect(OUTCOME_LABEL).toEqual({
      reproduced: "Reproduced",
      not_reproduced: "Not reproduced",
      implement: "Build it",
      already_done: "Already possible",
      needs_info: "Needs more information",
      out_of_scope: "Out of scope",
    });
    expect(Object.keys(OUTCOME_LABEL).sort()).toEqual([...InvestigationOutcome.options].sort());
  });
});

const spotCheckItem = InboxItem.parse({
  id: "inbox:factory-spot-checks:p-storefront",
  kind: "spot_check",
  priority: "low",
  notify: "needs_you",
  status: "open",
  title: "2 merges to spot-check (Storefront)",
  body: "Read each change in the PR view, then record what you found.",
  projectId: "p-storefront",
  sessionId: null,
  threadId: null,
  itemId: null,
  requestId: null,
  issue: null,
  pr: null,
  automationRunId: null,
  createdAt: "2026-11-15T09:00:00.000Z",
  updatedAt: "2026-11-15T09:00:00.000Z",
  resolvedAt: null,
  resolution: null,
});

describe("Open spot-checks from the inbox (#392)", () => {
  it("lands on the Spot-checks list, not the top of the project page", async () => {
    const root = createRootRoute({ component: Outlet });
    const router = createRouter({
      routeTree: root.addChildren([
        createRoute({
          getParentRoute: () => root,
          path: "/",
          component: () => <InboxActions item={spotCheckItem} />,
        }),
        createRoute({
          getParentRoute: () => root,
          path: "/projects/$projectId",
          component: () => <p>project page</p>,
        }),
      ]),
      history: createMemoryHistory({ initialEntries: ["/"] }),
    });
    render(
      <ClientProvider client={createMockClient()}>
        <QueryClientProvider client={new QueryClient()}>
          <TooltipProvider>
            <RouterProvider router={router} />
          </TooltipProvider>
        </QueryClientProvider>
      </ClientProvider>,
    );
    fireEvent.click(await screen.findByRole("button", { name: /Open spot-checks/ }));
    await screen.findByText("project page");
    expect(router.state.location.pathname).toBe("/projects/p-storefront");
    // The link names the Spot-checks card, so the page opens there.
    const target = router.state.location.hash;
    expect(target).toBe(SPOT_CHECKS_ANCHOR);
    const client = createMockClient();
    const { spotChecks } = await client.factory.status("p-storefront");
    const card = renderWithClient(
      <SpotChecksCard projectId="p-storefront" spotChecks={spotChecks} />,
      client,
      { withRouter: true },
    );
    await card.findByTestId("factory-spot-checks");
    expect(document.getElementById(target)).toBe(card.getByTestId("factory-spot-checks"));
  });

  it("opens the card at the anchor and scrolls it into view", async () => {
    // A no-op in jsdom (`setup.ts`), watched here.
    const scrolled = vi.spyOn(Element.prototype, "scrollIntoView");
    const client = createMockClient();
    const { spotChecks } = await client.factory.status("p-storefront");
    // Nothing outstanding: the card would start closed.
    const quiet = { ...spotChecks, outstanding: 0 };
    renderWithClient(<SpotChecksCard projectId="p-storefront" spotChecks={quiet} focus />, client, {
      withRouter: true,
    });
    const card = (await screen.findByTestId("factory-spot-checks")) as HTMLDetailsElement;
    expect(card.open).toBe(true);
    await waitFor(() => expect(scrolled).toHaveBeenCalled());
    expect(scrolled.mock.contexts.at(-1)).toBe(card);
  });
});

describe("the PR view opened from a spot-check (#392)", () => {
  it("offers Looks good and Found a problem beside the change, and records it there", async () => {
    const client = createMockClient();
    const { spotChecks } = await client.factory.status("p-storefront");
    const spotCheck = vi.spyOn(client.factory, "spotCheck");
    renderWithClient(<SpotChecksCard projectId="p-storefront" spotChecks={spotChecks} />, client, {
      withRouter: true,
    });
    const [first] = await screen.findAllByTestId("spot-check-pending");
    const waiting = spotChecks.pending[0];
    if (!first || !waiting) throw new Error("the demo factory has merges to spot-check");
    fireEvent.click(within(first).getByRole("button", { name: /Open PR/ }));
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByRole("button", { name: /Found a problem/ })).toBeTruthy();
    fireEvent.click(within(dialog).getByRole("button", { name: /Looks good/ }));
    // The same outcome as the card's button, and the dialog closes once it is recorded.
    await waitFor(() =>
      expect(spotCheck).toHaveBeenCalledWith("p-storefront", waiting.itemId, {
        verdict: "looks_good",
      }),
    );
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });
});
