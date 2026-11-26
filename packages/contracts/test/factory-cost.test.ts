import { describe, expect, it } from "vitest";
import {
  FactoryItemCost,
  FactoryItemResponse,
  FactoryLimits,
  FactoryWorkItem,
  hasItemBudget,
  itemBudgetReached,
  itemBudgetUsed,
  Project,
} from "../src";
import { sampleProject, ts } from "./fixtures";

const cost: FactoryItemCost = {
  usd: 12.4,
  tokens: 4_100_000,
  estimatedUsd: 3.1,
  unpricedTurns: 1,
  turns: 42,
  sessions: 5,
  apiEquivalent: true,
  cap: { usd: 15, tokens: null, spentUsd: 9.3, spentTokens: 3_000_000 },
};

const work = {
  id: "i1",
  title: "Add a counter",
  workKey: "issue:3",
  issue: null,
  pr: null,
  score: null,
  sessionId: null,
  stage: "building",
  source: "issue",
  reason: null,
  note: null,
  updatedAt: ts,
} as const;

describe("factory item cost and the per-item cap (#325)", () => {
  it("reads limits without a per-item cap as none and validates one", () => {
    expect(FactoryLimits.parse({}).itemBudget).toEqual({});
    const { itemBudget: _b, ...saved } = sampleProject.factoryLimits;
    expect(
      Project.parse({ ...sampleProject, factoryLimits: saved }).factoryLimits.itemBudget,
    ).toEqual({});
    expect(FactoryLimits.parse({ itemBudget: { usd: 5 } }).itemBudget).toEqual({ usd: 5 });
    expect(FactoryLimits.parse({ itemBudget: { tokens: 1_000_000 } }).itemBudget).toEqual({
      tokens: 1_000_000,
    });
    expect(FactoryLimits.safeParse({ itemBudget: { usd: 0 } }).success).toBe(false);
    expect(FactoryLimits.safeParse({ itemBudget: { usd: -1 } }).success).toBe(false);
    expect(FactoryLimits.safeParse({ itemBudget: { tokens: 0 } }).success).toBe(false);
    expect(FactoryLimits.safeParse({ itemBudget: { tokens: 1.5 } }).success).toBe(false);
    const capped = FactoryLimits.parse({ itemBudget: { usd: 2.5, tokens: 500_000 } });
    expect(FactoryLimits.parse(JSON.parse(JSON.stringify(capped)))).toEqual(capped);
  });

  it("says when the cap is set and when an item reached it", () => {
    const none = FactoryLimits.parse({});
    const usd = FactoryLimits.parse({ itemBudget: { usd: 5 } });
    const tokens = FactoryLimits.parse({ itemBudget: { tokens: 1_000 } });
    expect(hasItemBudget(none)).toBe(false);
    expect(hasItemBudget(usd)).toBe(true);
    expect(hasItemBudget(tokens)).toBe(true);
    expect(itemBudgetReached({ usd: 1e6, tokens: 1e9 }, none)).toBeNull();
    expect(itemBudgetReached({ usd: 4.99, tokens: 0 }, usd)).toBeNull();
    expect(itemBudgetReached({ usd: 5.1, tokens: 0 }, usd)).toBe("$5.10 of $5.00");
    expect(itemBudgetReached({ usd: 0, tokens: 999 }, tokens)).toBeNull();
    expect(itemBudgetReached({ usd: 0, tokens: 1_200 }, tokens)).toBe("1,200 of 1,000 tokens");
  });

  it("measures the share of the cap used", () => {
    expect(itemBudgetUsed(null)).toBeNull();
    expect(itemBudgetUsed(cost.cap)).toBeCloseTo(0.62);
    expect(itemBudgetUsed({ usd: 10, tokens: 1_000, spentUsd: 1, spentTokens: 900 })).toBeCloseTo(
      0.9,
    );
  });

  it("round-trips an item's cost on work items and the item response", () => {
    expect(FactoryItemCost.parse(JSON.parse(JSON.stringify(cost)))).toEqual(cost);
    // Without a cap and from an older server: the flags default.
    const { apiEquivalent: _a, cap: _c, ...plain } = cost;
    expect(FactoryItemCost.parse(plain)).toEqual({ ...plain, apiEquivalent: false, cap: null });
    expect(FactoryItemCost.safeParse({ ...cost, usd: -1 }).success).toBe(false);

    // A status from before item costs: no cost.
    expect(FactoryWorkItem.parse(work).cost).toBeNull();
    const withCost = FactoryWorkItem.parse({ ...work, cost });
    expect(FactoryWorkItem.parse(JSON.parse(JSON.stringify(withCost)))).toEqual(withCost);
    expect(withCost.cost).toEqual(cost);
  });

  it("carries the cost beside the item in its response", () => {
    const item = {
      id: "i1",
      projectId: "p1",
      workKey: "issue:3",
      title: "Add a counter",
      summary: "",
      source: "issue",
      area: null,
      acceptanceCriteria: [],
      score: null,
      stage: "building",
      issue: null,
      pr: null,
      builderSessionId: "s1",
      builderProvider: "claude",
      reviewerSessionId: null,
      reviewerProvider: null,
      reviewerNote: null,
      review: null,
      checks: [],
      attempts: 0,
      reason: null,
      note: null,
      mergeSha: null,
      revertOf: null,
      triageRequestedAt: null,
      createdAt: ts,
      updatedAt: ts,
      mergedAt: null,
      finishedAt: null,
    };
    const old = FactoryItemResponse.parse({ item });
    expect(old.cost).toBeNull();
    expect(old.item.sessionIds).toEqual([]);
    expect(old.item.itemBudgetSince).toBeNull();
    const res = FactoryItemResponse.parse({
      item: { ...item, sessionIds: ["s0", "s1"], itemBudgetSince: ts },
      cost,
    });
    expect(FactoryItemResponse.parse(JSON.parse(JSON.stringify(res)))).toEqual(res);
    expect(res.item.sessionIds).toEqual(["s0", "s1"]);
  });
});
