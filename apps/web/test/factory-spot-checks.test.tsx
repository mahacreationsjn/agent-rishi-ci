import type { FactorySpotChecks, SpotCheckEntry } from "@agent-rishi/contracts";
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import {
  showSpotChecks,
  spotCheckProblemText,
  spotCheckShareText,
} from "@/components/factory/spot-checks";
import { SpotChecksCard } from "@/components/factory/spot-checks-card";
import { createMockClient } from "@/lib/api/mock";
import { renderWithClient } from "./utils";

/** The factory panel's Spot-checks list (#380). */

const at = "2026-11-15T09:00:00.000Z";

const entry = (patch: Partial<SpotCheckEntry> = {}): SpotCheckEntry => ({
  itemId: "fw-8",
  title: "Sticky add-to-cart bar on mobile",
  pr: { number: 55, url: "https://github.com/acme/app/pull/55", state: "merged" },
  issue: null,
  check: {
    reason: "sampled",
    state: "pending",
    sampledAt: at,
    checkedAt: null,
    note: null,
    issue: null,
  },
  mergedAt: at,
  verdict: { verdict: "approve", summary: "Meets every criterion" },
  ...patch,
});

const spotChecks = (patch: Partial<FactorySpotChecks> = {}): FactorySpotChecks => ({
  percent: 10,
  outstanding: 1,
  checked30d: 7,
  problems30d: 1,
  pending: [entry()],
  recent: [
    entry({
      itemId: "fw-11",
      title: "Fix footer link contrast",
      check: {
        reason: "large_change",
        state: "problem",
        sampledAt: at,
        checkedAt: at,
        note: "The hover colour fails contrast too",
        issue: null,
      },
    }),
  ],
  ...patch,
});

describe("spot-check wording (#380)", () => {
  it("says the share in force and how often a person found a problem", () => {
    expect(spotCheckShareText(10)).toBe(
      "10% of automatic merges, plus untrusted-author work and large changes",
    );
    expect(spotCheckShareText(0)).toMatch(/^Off/);
    expect(spotCheckProblemText({ checked30d: 7, problems30d: 1 })).toBe(
      "A person found a problem in 1 of 7 checked merges (14%) over 30 days",
    );
    expect(spotCheckProblemText({ checked30d: 0, problems30d: 0 })).toBe(
      "None checked in the last 30 days",
    );
    expect(showSpotChecks(spotChecks({ percent: 0, pending: [], recent: [] }))).toBe(false);
    expect(showSpotChecks(spotChecks({ percent: 0 }))).toBe(true);
  });
});

describe("the Spot-checks card (#380)", () => {
  it("lists what waits with its verdict and actions, and what was checked", async () => {
    renderWithClient(<SpotChecksCard projectId="p-app" spotChecks={spotChecks()} />, undefined, {
      withRouter: true,
    });
    const pending = await screen.findByTestId("spot-check-pending");
    expect(pending.textContent).toContain("Sticky add-to-cart bar on mobile");
    expect(pending.textContent).toContain("Reviewer: approve");
    expect(pending.textContent).toContain("#55");
    for (const name of [/Open PR/, /Looks good/, /Found a problem/]) {
      expect(within(pending).getByRole("button", { name })).toBeTruthy();
    }
    expect(screen.getByTestId("spot-check-share").textContent).toContain("1 of 7 checked merges");
    const recent = screen.getByTestId("spot-check-recent");
    expect(recent.textContent).toContain("found a problem");
    expect(recent.textContent).toContain("The hover colour fails contrast too");
    // A problem recorded without its issue offers File issue.
    expect(within(recent).getByRole("button", { name: /File issue/ })).toBeTruthy();
  });

  it("is hidden while spot-checks are off and nothing was checked", () => {
    renderWithClient(
      <SpotChecksCard
        projectId="p-app"
        spotChecks={spotChecks({ percent: 0, outstanding: 0, pending: [], recent: [] })}
      />,
    );
    expect(screen.queryByTestId("factory-spot-checks")).toBeNull();
  });

  it("records Looks good, and a problem with its note and a follow-up issue", async () => {
    const client = createMockClient();
    const spotCheck = vi.fn(async () => ({
      item: await client.factory.item("p-storefront", "fw-8").then((r) => r.item),
      issueError: null,
    }));
    client.factory.spotCheck = spotCheck;
    renderWithClient(<SpotChecksCard projectId="p-app" spotChecks={spotChecks()} />, client, {
      withRouter: true,
    });
    const pending = await screen.findByTestId("spot-check-pending");
    fireEvent.click(within(pending).getByRole("button", { name: /Looks good/ }));
    await waitFor(() =>
      expect(spotCheck).toHaveBeenCalledWith("p-app", "fw-8", { verdict: "looks_good" }),
    );

    const found = within(pending).getByRole("button", { name: /Found a problem/ });
    // Enabled again once the first decision is recorded.
    await waitFor(() => expect((found as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(found);
    const record = await screen.findByRole("button", { name: "Record problem" });
    // A note is required.
    expect((record as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(screen.getByLabelText("What you found"), {
      target: { value: "  The bar covers the cookie banner  " },
    });
    fireEvent.click(record);
    await waitFor(() =>
      expect(spotCheck).toHaveBeenLastCalledWith("p-app", "fw-8", {
        verdict: "problem",
        note: "The bar covers the cookie banner",
        fileIssue: true,
      }),
    );
  });

  it("moves a decision from the list in the mock client", async () => {
    const client = createMockClient();
    const before = await client.factory.status("p-storefront");
    const waiting = before.spotChecks.pending[0];
    if (!waiting) throw new Error("the demo factory has merges to spot-check");
    expect(before.spotChecks.percent).toBe(10);
    const res = await client.factory.spotCheck("p-storefront", waiting.itemId, {
      verdict: "problem",
      note: "Off by one",
    });
    expect(res.item.spotCheck).toMatchObject({ state: "problem", note: "Off by one" });
    expect(res.item.spotCheck?.issue?.number).toBeGreaterThan(0);
    const after = await client.factory.status("p-storefront");
    expect(after.spotChecks.outstanding).toBe(before.spotChecks.outstanding - 1);
    expect(after.spotChecks.recent[0]?.itemId).toBe(waiting.itemId);
  });
});
