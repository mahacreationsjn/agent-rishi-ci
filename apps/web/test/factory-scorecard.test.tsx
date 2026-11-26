import type {
  EventEnvelope,
  FactoryScorecard,
  FactoryScorecardRow,
  ScorecardDays,
} from "@agent-rishi/contracts";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, fireEvent, renderHook, screen, waitFor, within } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  agentLabel,
  costPerMerge,
  costPerMergeTitle,
  firstPassRate,
  medianMerge,
  mergeRate,
  reviseAverage,
  rowLabel,
  spotChecks,
  spotChecksTitle,
} from "@/components/factory/scorecard";
import { ScorecardCard } from "@/components/factory/scorecard-card";
import { type AgentRishiClient, ClientProvider } from "@/lib/api";
import { createMockClient } from "@/lib/api/mock";
import { invalidateFactory, SCORECARD_REFRESH_MS, useFactoryScorecard } from "@/lib/factory";
import { renderWithClient } from "./utils";

/** The factory scorecard on the factory panel (#361). */

const names = (id: string) => ({ claude: "Claude", codex: "Codex" })[id] ?? id;

const row = (patch: Partial<FactoryScorecardRow> = {}): FactoryScorecardRow => ({
  key: "k",
  builder: { provider: "claude", model: "claude-opus-4-5" },
  reviewer: { provider: "codex", model: null },
  finished: 4,
  merged: 3,
  failed: 1,
  firstPass: 2,
  reviseRounds: 3,
  reverted: 1,
  medianMergeMs: 3 * 60 * 60 * 1000 + 10 * 60 * 1000,
  costUsd: 12.3,
  costPerMergeUsd: 4.1,
  estimatedUsd: 12.3,
  unpricedTurns: 0,
  apiEquivalent: true,
  spotChecked: 2,
  spotProblems: 1,
  ...patch,
});

describe("the scorecard's figures (#361)", () => {
  it("names builders, reviewers and pairs by provider and model", () => {
    expect(agentLabel({ provider: "claude", model: "claude-opus-4-5" }, names)).toBe(
      "Claude · claude-opus-4-5",
    );
    expect(agentLabel({ provider: "codex", model: null }, names)).toBe("Codex · default model");
    expect(agentLabel(null, names)).toBe("No review");
    expect(rowLabel(row(), "builders", names)).toBe("Claude · claude-opus-4-5");
    expect(rowLabel(row(), "reviewers", names)).toBe("Codex · default model");
    expect(rowLabel(row({ reviewer: null }), "pairs", names)).toBe(
      "Claude · claude-opus-4-5 → No review",
    );
  });

  it("shows rates, averages, time to merge and cost per merge with honest labels", () => {
    expect(mergeRate(row())).toBe("75%");
    expect(firstPassRate(row())).toBe("67%");
    expect(reviseAverage(row())).toBe("0.8");
    expect(medianMerge(row())).toBe("3h 10m");
    expect(costPerMerge(row())).toBe("≈ $4.10");
    expect(costPerMerge(row({ estimatedUsd: 0 }))).toBe("$4.10");
    expect(costPerMergeTitle(row())).toBe(
      "API-equivalent cost per merge, failures included (estimated from list prices): ≈ $12.30 over 4 items",
    );
    const none = row({ merged: 0, firstPass: 0, medianMergeMs: null, costPerMergeUsd: null });
    expect([mergeRate(none), firstPassRate(none), medianMerge(none), costPerMerge(none)]).toEqual([
      "0%",
      "—",
      "—",
      "—",
    ]);
    const unpriced = row({ costUsd: 0, costPerMergeUsd: 0, estimatedUsd: 0, unpricedTurns: 5 });
    expect(costPerMerge(unpriced)).toBe("Not priced");
    expect(costPerMergeTitle(unpriced)).toMatch(/· 5 turns not priced$/);
  });

  it("shows the merges people spot-checked and the problems they found (#380)", () => {
    expect(spotChecks(row())).toBe("2 · 1 problem");
    expect(spotChecks(row({ spotChecked: 4, spotProblems: 0 }))).toBe("4 · 0 problems");
    expect(spotChecks(row({ spotChecked: 0, spotProblems: 0 }))).toBe("—");
    expect(spotChecksTitle(row())).toBe("2 merges spot-checked by a person, 1 with a problem");
  });
});

describe("the Scorecard card (#361)", () => {
  const card = (days: ScorecardDays, rows: FactoryScorecardRow[]): FactoryScorecard => ({
    projectId: "p-app",
    days,
    since: "2026-10-15T12:00:00.000Z",
    finished: rows.reduce((n, r) => n + r.finished, 0),
    builders: rows.map((r) => ({ ...r, reviewer: null })),
    reviewers: rows.map((r) => ({ ...r, builder: null })),
    pairs: rows,
  });

  /** Open the collapsed card, as a click on its summary does. */
  const open = () => {
    const details = screen.getByTestId("factory-scorecard") as HTMLDetailsElement;
    details.open = true;
    fireEvent(details, new Event("toggle"));
  };

  it("loads only once opened, then switches grouping and window", async () => {
    const client = createMockClient();
    const scorecard = vi.fn(async (_id: string, days: ScorecardDays) =>
      card(days, days === 7 ? [] : [row(), row({ key: "k2", reviewer: null, reverted: 0 })]),
    );
    client.factory.scorecard = scorecard;
    renderWithClient(<ScorecardCard projectId="p-app" />, client);
    expect(scorecard).not.toHaveBeenCalled();

    open();
    await waitFor(() => expect(screen.getAllByTestId("factory-scorecard-row")).toHaveLength(2));
    expect(scorecard).toHaveBeenCalledWith("p-app", 30);
    const first = screen.getAllByTestId("factory-scorecard-row")[0] as HTMLElement;
    expect(within(first).getByText("Claude")).toBeTruthy();
    expect(within(first).getByText("claude-opus-4-5")).toBeTruthy();
    expect(first.textContent).toContain("67%");
    expect(first.textContent).toContain("≈ $4.10");
    expect(first.textContent).toContain("2 · 1 problem");

    fireEvent.click(screen.getByRole("button", { name: "Reviewer" }));
    const reviewers = screen.getAllByTestId("factory-scorecard-row");
    expect(reviewers[0]?.textContent).toContain("default model");
    expect(reviewers[1]?.textContent).toContain("No review");

    fireEvent.click(screen.getByRole("button", { name: "7 days" }));
    expect(await screen.findByText("No finished factory work in the last 7 days.")).toBeTruthy();
    expect(scorecard).toHaveBeenLastCalledWith("p-app", 7);
  });

  it("shows a demo scorecard for a factory project in the mock client", async () => {
    const client = createMockClient();
    renderWithClient(<ScorecardCard projectId="p-storefront" />, client);
    open();
    await waitFor(() =>
      expect(screen.getAllByTestId("factory-scorecard-row").length).toBeGreaterThan(1),
    );
    // Builder and reviewer lists add up to the same work; outside a factory there is none.
    const demo = await client.factory.scorecard("p-storefront", 90);
    const total = (rows: FactoryScorecardRow[]) => rows.reduce((n, r) => n + r.finished, 0);
    expect(total(demo.builders)).toBe(demo.finished);
    expect(total(demo.reviewers)).toBe(demo.finished);
    expect(total(demo.pairs)).toBe(demo.finished);
    expect((await client.factory.scorecard("p-nope", 30)).finished).toBe(0);
  });
});

describe("the scorecard's refresh on factory events (#361)", () => {
  const event = (type: string) => ({ type, seq: 1, sessionId: null }) as unknown as EventEnvelope;
  let queryClient: QueryClient;
  beforeEach(() => {
    vi.useFakeTimers();
    queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  });
  afterEach(() => {
    queryClient.clear();
    vi.useRealTimers();
  });
  const advance = (ms: number) => act(() => vi.advanceTimersByTimeAsync(ms));

  it("refetches an open scorecard once per burst of events, not once per event", async () => {
    const scorecard = vi.fn(async (_id: string, days: ScorecardDays) => ({
      projectId: "p-app",
      days,
      since: "2026-10-15T12:00:00.000Z",
      finished: 0,
      builders: [],
      reviewers: [],
      pairs: [],
    }));
    const client = { factory: { scorecard } } as unknown as AgentRishiClient;
    const wrapper = ({ children }: { children: ReactNode }) => (
      <ClientProvider client={client}>
        <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
      </ClientProvider>
    );
    const hook = renderHook(() => useFactoryScorecard("p-app", 30), { wrapper });
    await advance(0);
    expect(scorecard).toHaveBeenCalledTimes(1);

    // A busy factory: an item update every second.
    for (let n = 0; n < 10; n++) {
      act(() => invalidateFactory(queryClient, event("factory.item.updated")));
      await advance(1_000);
    }
    expect(scorecard).toHaveBeenCalledTimes(1);
    await advance(SCORECARD_REFRESH_MS);
    // One refetch covered the whole burst; with no event since, none follows.
    expect(scorecard).toHaveBeenCalledTimes(2);
    await advance(SCORECARD_REFRESH_MS);
    expect(scorecard).toHaveBeenCalledTimes(2);
    // Events that aren't the factory's change nothing.
    act(() => invalidateFactory(queryClient, event("session.updated")));
    await advance(SCORECARD_REFRESH_MS);
    expect(scorecard).toHaveBeenCalledTimes(2);
    hook.unmount();
  });
});
