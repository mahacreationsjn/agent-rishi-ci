import type { FactoryItemCost } from "@agent-rishi/contracts";
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { capText, costFact, costText, costTitle, nearCap } from "@/components/factory/item-cost";
import { viewPipeline } from "@/components/factory-view/stages";
import { ViewCardButton } from "@/components/factory-view/view-card";
import { NOW, status, w } from "./scene-fixtures";

/** What a factory item cost, on its Factory view card, side sheet and page (#325). */

const cost = (patch: Partial<FactoryItemCost> = {}): FactoryItemCost => ({
  usd: 12.4,
  tokens: 4_100_000,
  estimatedUsd: 12.4,
  unpricedTurns: 0,
  turns: 42,
  sessions: 3,
  apiEquivalent: true,
  cap: null,
  ...patch,
});

describe("an item's cost labels (#325)", () => {
  it("labels estimates, API-equivalent figures and unpriced work honestly", () => {
    expect(costText(cost())).toBe("≈ $12.40");
    expect(costText(cost({ estimatedUsd: 0 }))).toBe("$12.40");
    expect(costFact(cost())).toBe("≈ $12.40 · 4.1M tokens");
    expect(costTitle(cost())).toBe(
      "API-equivalent cost so far (estimated from list prices) · 3 sessions · 42 turns · 4.1M tokens",
    );
    expect(costTitle(cost({ apiEquivalent: false, estimatedUsd: 0, unpricedTurns: 2 }))).toBe(
      "Cost so far · 3 sessions · 42 turns · 4.1M tokens · 2 turns not priced",
    );
    const unpriced = cost({ usd: 0, estimatedUsd: 0, unpricedTurns: 42 });
    expect(costText(unpriced)).toBe("Not priced");
    expect(costTitle(unpriced)).toMatch(/^Not priced/);
  });

  it("says where the item stands against the per-item cap", () => {
    expect(capText(cost())).toBeNull();
    expect(capText(null)).toBeNull();
    const usd = cost({ cap: { usd: 15, tokens: null, spentUsd: 9.3, spentTokens: 3_000_000 } });
    expect(capText(usd)).toBe("$9.30 of $15.00");
    expect(nearCap(usd)).toBe(false);
    const both = cost({
      cap: { usd: 15, tokens: 2_000_000, spentUsd: 9.3, spentTokens: 1_800_000 },
    });
    expect(capText(both)).toBe("$9.30 of $15.00 · 1.8M of 2.0M tokens");
    expect(nearCap(both)).toBe(true);
  });
});

describe("the Factory view card's cost (#325)", () => {
  const cardOf = (patch: Parameters<typeof w>[2]) => {
    const item = w("i1", 12, { stage: "building", step: "implement", ...patch });
    const p = viewPipeline(status({ inProgress: [item] }), new Map(), NOW);
    const card = p.stages.building[0];
    if (!card) throw new Error("no card");
    return card;
  };

  it("shows what the item cost, with the kind of figure on hover", () => {
    render(<ViewCardButton card={cardOf({ cost: cost() })} now={NOW} onOpen={() => {}} />);
    const pill = screen.getByTestId("factory-view-card-cost");
    expect(pill.textContent).toContain("≈ $12.40");
    expect(pill.getAttribute("title")).toMatch(/^API-equivalent cost so far \(estimated/);
    expect(screen.getByRole("button").getAttribute("aria-label")).toMatch(/cost ≈ \$12\.40$/);
  });

  it("marks an item close to its cap and shows nothing before any usage", () => {
    const near = cost({ cap: { usd: 10, tokens: null, spentUsd: 9, spentTokens: 0 } });
    const { unmount } = render(
      <ViewCardButton card={cardOf({ cost: near })} now={NOW} onOpen={() => {}} />,
    );
    const pill = screen.getByTestId("factory-view-card-cost");
    expect(pill.className).toMatch(/text-status-waiting/);
    expect(pill.getAttribute("title")).toMatch(/Spend cap: \$9\.00 of \$10\.00$/);
    unmount();
    render(<ViewCardButton card={cardOf({ cost: null })} now={NOW} onOpen={() => {}} />);
    expect(screen.queryByTestId("factory-view-card-cost")).toBeNull();
  });
});
