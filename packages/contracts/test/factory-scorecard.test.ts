import { describe, expect, it } from "vitest";
import {
  FactoryScorecard,
  FactoryScorecardQuery,
  type FactoryScorecardRow,
  SCORECARD_WINDOWS,
} from "../src";
import { ts } from "./fixtures";

const row: FactoryScorecardRow = {
  key: "codex:gpt-5.5|claude:-",
  builder: { provider: "codex", model: "gpt-5.5" },
  reviewer: { provider: "claude", model: null },
  finished: 5,
  merged: 4,
  failed: 1,
  firstPass: 3,
  reviseRounds: 2,
  reverted: 1,
  medianMergeMs: 5_400_000,
  costUsd: 21.5,
  costPerMergeUsd: 5.375,
  estimatedUsd: 1.25,
  unpricedTurns: 0,
  apiEquivalent: true,
  spotChecked: 2,
  spotProblems: 1,
};

describe("factory scorecard (#361)", () => {
  it("reads the window from the query string, 30 days by default", () => {
    expect(FactoryScorecardQuery.parse({})).toEqual({ days: 30 });
    for (const days of SCORECARD_WINDOWS) {
      expect(FactoryScorecardQuery.parse({ days: String(days) })).toEqual({ days });
    }
    for (const days of ["0", "14", "365", "abc", "30.5", ""]) {
      expect(FactoryScorecardQuery.safeParse({ days }).success).toBe(false);
    }
  });

  it("round-trips a scorecard", () => {
    const card: FactoryScorecard = {
      projectId: "p1",
      days: 30,
      since: ts,
      finished: 5,
      builders: [{ ...row, key: "codex:gpt-5.5", reviewer: null }],
      reviewers: [{ ...row, key: "claude:-", builder: null }],
      pairs: [row, { ...row, key: "codex:gpt-5.5|none", reviewer: null, merged: 0, firstPass: 0 }],
    };
    expect(FactoryScorecard.parse(JSON.parse(JSON.stringify(card)))).toEqual(card);
  });

  it("reads rows from before spot-checks as none checked (#380)", () => {
    const { spotChecked: _c, spotProblems: _p, ...old } = row;
    const card = { projectId: "p1", days: 30, since: ts, finished: 5, builders: [old] };
    const parsed = FactoryScorecard.parse({ ...card, reviewers: [], pairs: [] });
    expect(parsed.builders[0]).toMatchObject({ spotChecked: 0, spotProblems: 0 });
    expect(
      FactoryScorecard.safeParse({
        ...card,
        builders: [{ ...row, spotProblems: -1 }],
        reviewers: [],
        pairs: [],
      }).success,
    ).toBe(false);
  });

  it("rejects figures that can't be", () => {
    const card = { projectId: "p1", days: 7, since: ts, finished: 1, builders: [], pairs: [] };
    expect(FactoryScorecard.safeParse({ ...card, reviewers: [] }).success).toBe(true);
    expect(FactoryScorecard.safeParse({ ...card, days: 14, reviewers: [] }).success).toBe(false);
    expect(
      FactoryScorecard.safeParse({ ...card, reviewers: [{ ...row, merged: -1 }] }).success,
    ).toBe(false);
    expect(
      FactoryScorecard.safeParse({
        ...card,
        reviewers: [{ ...row, builder: { provider: "codex", model: "" } }],
      }).success,
    ).toBe(false);
  });
});
