import { randomUUID } from "node:crypto";
import {
  type FactoryItem,
  type FactoryItemCost,
  FactoryScorecard,
  type FactoryScorecardRow,
} from "@agent-rishi/contracts";
import { afterEach, describe, expect, it } from "vitest";
import { projectFactoryRoutes } from "../src/routes/factory";
import type { AppServices } from "../src/services/container";
import { scorecard } from "../src/services/factory/scorecard";
import { FACTORY_STARTER } from "../src/services/factory/sessions";
import { REVERTED_AT } from "../src/services/factory/stats";
import { createFactoryEnv, type FactoryEnv } from "./support/factory-env";
import { factorySteps } from "./support/factory-steps";

/**
 * The factory scorecard (#361): first-pass merges, revise rounds, reverts, cost and time to
 * merge by builder and reviewer, provider and model, over the work that finished in a window.
 */

const NOW = new Date("2026-11-14T12:00:00.000Z");
const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
const ago = (ms: number) => new Date(NOW.getTime() - ms).toISOString();

const base: FactoryItem = {
  id: "i0",
  projectId: "p1",
  workKey: "issue:1",
  title: "Work",
  summary: "",
  source: "issue",
  area: null,
  acceptanceCriteria: [],
  score: null,
  stage: "merged",
  type: "feature",
  classification: null,
  trust: "trusted",
  author: null,
  admittedBy: null,
  investigation: null,
  specApproval: null,
  issue: null,
  pr: null,
  builderSessionId: "b-claude",
  builderProvider: "claude",
  reviewerSessionId: "r-codex",
  reviewerProvider: "codex",
  reviewerNote: null,
  review: null,
  lessonsNote: null,
  followUps: [],
  spotCheck: null,
  checks: [],
  attempts: 0,
  reason: null,
  stop: null,
  failureKind: null,
  rebuiltFrom: null,
  note: null,
  mergeSha: null,
  mergePath: null,
  revertOf: null,
  triageRequestedAt: null,
  nudges: {},
  largeChange: null,
  sessionsArchivedAt: null,
  earlierSessionIds: [],
  sessionIds: [],
  itemBudgetSince: null,
  stepSince: null,
  createdAt: ago(5 * HOUR),
  updatedAt: ago(HOUR),
  mergedAt: null,
  finishedAt: null,
};
const item = (id: string, patch: Partial<FactoryItem>): FactoryItem => ({ ...base, id, ...patch });

/** Merged `hoursAgo`, taken in `took` hours before that. */
const merged = (id: string, hoursAgo: number, took: number, patch: Partial<FactoryItem> = {}) =>
  item(id, {
    stage: "merged",
    createdAt: ago((hoursAgo + took) * HOUR),
    mergedAt: ago(hoursAgo * HOUR),
    finishedAt: ago(hoursAgo * HOUR),
    ...patch,
  });
const failed = (id: string, hoursAgo: number, patch: Partial<FactoryItem> = {}) =>
  item(id, {
    stage: "failed",
    failureKind: "checks",
    reason: "review: changes requested",
    finishedAt: ago(hoursAgo * HOUR),
    ...patch,
  });

const models = new Map<string, string | null>([
  ["b-claude", "claude-opus-4-5"],
  ["b-codex", "gpt-5.5"],
  ["b-codex-mini", "gpt-5.5-mini"],
  ["r-codex", "gpt-5.5"],
  ["r-claude", null],
]);
const cost = (usd: number, patch: Partial<FactoryItemCost> = {}): FactoryItemCost => ({
  usd,
  tokens: usd * 100_000,
  estimatedUsd: 0,
  unpricedTurns: 0,
  turns: 1,
  sessions: 1,
  apiEquivalent: false,
  cap: null,
  ...patch,
});

const rowOf = (rows: FactoryScorecardRow[], provider: string, model: string | null) =>
  rows.find(
    (r) =>
      (r.builder ?? r.reviewer)?.provider === provider &&
      (r.builder ?? r.reviewer)?.model === model,
  );

describe("the factory scorecard (#361)", () => {
  it("scores builders, reviewers and their pairs by provider and model", () => {
    const items = [
      // Claude builds, Codex reviews: two first-pass merges, one after a revise round, one failure.
      merged("a", 2, 1),
      merged("b", 3, 3),
      merged("c", 4, 5, { attempts: 2 }),
      failed("d", 6, { attempts: 2 }),
      // Codex builds (two models), Claude reviews on its default model.
      merged("e", 1, 2, {
        builderSessionId: "b-codex",
        builderProvider: "codex",
        reviewerSessionId: "r-claude",
        reviewerProvider: "claude",
        attempts: 1,
      }),
      merged("f", 1, 4, {
        builderSessionId: "b-codex-mini",
        builderProvider: "codex",
        reviewerSessionId: "r-claude",
        reviewerProvider: "claude",
      }),
    ];
    const costs = new Map([
      ["a", cost(1)],
      ["b", cost(2, { estimatedUsd: 0.5 })],
      ["c", cost(4, { unpricedTurns: 1 })],
      ["d", cost(5, { apiEquivalent: true })],
      ["e", cost(3)],
      ["f", cost(0.5)],
    ]);
    const card = scorecard("p1", items, { models, costs }, NOW, 30);
    expect(FactoryScorecard.parse(card)).toEqual(card);
    expect(card).toMatchObject({ projectId: "p1", days: 30, since: ago(30 * DAY), finished: 6 });

    const claude = rowOf(card.builders, "claude", "claude-opus-4-5");
    expect(claude).toEqual({
      key: expect.any(String),
      builder: { provider: "claude", model: "claude-opus-4-5" },
      reviewer: null,
      finished: 4,
      merged: 3,
      failed: 1,
      firstPass: 2,
      reviseRounds: 4,
      reverted: 0,
      medianMergeMs: 3 * HOUR,
      costUsd: 12,
      // Failures cost too: what one merge cost all told.
      costPerMergeUsd: 4,
      estimatedUsd: 0.5,
      unpricedTurns: 1,
      apiEquivalent: true,
      spotChecked: 0,
      spotProblems: 0,
    });
    expect(rowOf(card.builders, "codex", "gpt-5.5")).toMatchObject({
      finished: 1,
      merged: 1,
      firstPass: 0,
      reviseRounds: 1,
      medianMergeMs: 2 * HOUR,
      costPerMergeUsd: 3,
    });
    expect(rowOf(card.builders, "codex", "gpt-5.5-mini")).toMatchObject({
      merged: 1,
      firstPass: 1,
      costPerMergeUsd: 0.5,
    });
    // Most finished work first, then most merges.
    expect(card.builders.map((r) => r.builder?.model)).toEqual([
      "claude-opus-4-5",
      "gpt-5.5",
      "gpt-5.5-mini",
    ]);

    // Reviewers: Codex reviewed Claude's four, Claude (default model) reviewed both Codex builds.
    expect(card.reviewers.map((r) => [r.reviewer, r.finished, r.merged])).toEqual([
      [{ provider: "codex", model: "gpt-5.5" }, 4, 3],
      [{ provider: "claude", model: null }, 2, 2],
    ]);
    expect(card.reviewers.every((r) => r.builder === null)).toBe(true);

    // Pairs keep both sides; every key is unique within a list.
    expect(card.pairs).toHaveLength(3);
    expect(card.pairs[0]).toMatchObject({
      builder: { provider: "claude", model: "claude-opus-4-5" },
      reviewer: { provider: "codex", model: "gpt-5.5" },
      finished: 4,
    });
    for (const list of [card.builders, card.reviewers, card.pairs]) {
      expect(new Set(list.map((r) => r.key)).size).toBe(list.length);
    }
  });

  it("counts a reverted merge as merged and reverted, never as a first pass", () => {
    const card = scorecard(
      "p1",
      [
        // Reverted, then back with its builder for a revise round: its merge stays on record.
        merged("r1", 10, 2, {
          stage: "building",
          attempts: 1,
          finishedAt: null,
          nudges: { [REVERTED_AT]: ago(9 * HOUR) },
        }),
        // Reverted before `reverted_at` existed: the stage says so.
        merged("r2", 20, 2, { stage: "reverted", finishedAt: ago(19 * HOUR) }),
        merged("ok", 30, 2),
      ],
      { models, costs: new Map() },
      NOW,
      7,
    );
    expect(card.reviewers[0]).toMatchObject({ merged: 3, reverted: 2, firstPass: 1 });
    // Without a ledger the cost reads as nothing spent.
    expect(card.builders[0]).toMatchObject({ costUsd: 0, costPerMergeUsd: 0 });
  });

  it("counts what people found on spot-checks against the builder and reviewer (#380)", () => {
    const check = (state: "pending" | "looks_good" | "problem") => ({
      spotCheck: {
        reason: "sampled" as const,
        state,
        sampledAt: ago(3 * HOUR),
        checkedAt: state === "pending" ? null : ago(HOUR),
        note: state === "problem" ? "Leaks a timer" : null,
        issue: null,
      },
    });
    const codex = {
      builderSessionId: "b-codex",
      builderProvider: "codex",
      reviewerSessionId: "r-claude",
      reviewerProvider: "claude",
    };
    const card = scorecard(
      "p1",
      [
        merged("s1", 3, 1, check("problem")),
        merged("s2", 4, 1, check("looks_good")),
        merged("s3", 5, 1, check("pending")),
        merged("s4", 6, 1),
        merged("s5", 7, 1, { ...codex, ...check("looks_good") }),
      ],
      { models, costs: new Map() },
      NOW,
      7,
    );
    expect(rowOf(card.builders, "claude", "claude-opus-4-5")).toMatchObject({
      merged: 4,
      spotChecked: 2,
      spotProblems: 1,
    });
    expect(rowOf(card.reviewers, "codex", "gpt-5.5")).toMatchObject({
      spotChecked: 2,
      spotProblems: 1,
    });
    expect(rowOf(card.builders, "codex", "gpt-5.5")).toMatchObject({
      spotChecked: 1,
      spotProblems: 0,
    });
    expect(card.pairs.map((r) => [r.spotChecked, r.spotProblems])).toEqual([
      [2, 1],
      [1, 0],
    ]);
  });

  it("counts only work that finished in the window, from its own work", () => {
    const items = [
      merged("in", 24, 1),
      merged("old", 40 * 24, 1),
      failed("failed-old", 40 * 24),
      failed("failed-in", 24),
      // Failures outside its code go back by themselves, new and old.
      failed("infra", 24, { failureKind: "infrastructure" }),
      failed("infra-legacy", 24, { failureKind: null, reason: "The builder session failed" }),
      // Stuck work counts (it stopped short); merged, then reverted and failed: its merge counts.
      failed("stuck", 24, { failureKind: "stuck" }),
      failed("merged-then-failed", 24, { mergedAt: ago(30 * HOUR) }),
      // Not results: declined, escalated, unfinished, never built, the factory's own revert.
      item("rejected", { stage: "rejected", finishedAt: ago(HOUR) }),
      item("escalated", { stage: "escalated", finishedAt: ago(HOUR) }),
      item("building", { stage: "building" }),
      failed("no-builder", 24, { builderProvider: null, builderSessionId: null }),
      merged("revert", 24, 1, { source: "revert" }),
    ];
    const card30 = scorecard("p1", items, { models, costs: new Map() }, NOW, 30);
    expect(card30.finished).toBe(4);
    expect(card30.builders).toEqual([
      expect.objectContaining({ finished: 4, merged: 2, failed: 2 }),
    ]);
    const card90 = scorecard("p1", items, { models, costs: new Map() }, NOW, 90);
    expect(card90.builders[0]).toMatchObject({ finished: 6, merged: 3, failed: 3 });
    expect(scorecard("p1", [], { models, costs: new Map() }, NOW, 7)).toMatchObject({
      finished: 0,
      builders: [],
      reviewers: [],
      pairs: [],
    });
  });

  it("reads a model it can't find as the provider's default, and no reviewer as no review", () => {
    const card = scorecard(
      "p1",
      [
        merged("docs", 1, 1, {
          type: "docs",
          builderSessionId: "gone",
          reviewerSessionId: null,
          reviewerProvider: null,
        }),
      ],
      { models, costs: new Map() },
      NOW,
      30,
    );
    expect(card.builders[0]?.builder).toEqual({ provider: "claude", model: null });
    expect(card.reviewers[0]?.reviewer).toBeNull();
    expect(card.pairs[0]).toMatchObject({
      builder: { provider: "claude", model: null },
      reviewer: null,
    });
  });
});

describe("the scorecard over the factory's store, sessions and ledger (#361)", () => {
  let env: FactoryEnv;
  afterEach(() => env?.close());
  const { enable, backlogItem } = factorySteps(() => env);

  async function session(workKey: string, provider: string, model: string | null) {
    const res = await env.sessions.start({
      projectId: env.project.id,
      role: "agent",
      startedBy: FACTORY_STARTER,
      workKey,
      provider,
    } as Parameters<FactoryEnv["sessions"]["start"]>[0]);
    if (res.status !== "started") throw new Error("not started");
    env.repo.update(res.sessionId, (s) => ({ ...s, model, status: "idle" }));
    return res.sessionId;
  }

  it("attributes work to its sessions' models, archived or not, and prices it from the ledger", async () => {
    env = createFactoryEnv({ providers: ["claude", "codex"] });
    await enable();
    const created = backlogItem("Add a counter", 7);
    const builder = await session("issue:7", "codex", "gpt-5.5");
    const reviewer = await session(`factory:review:${created.id}`, "claude", "claude-opus-4-5");
    // Cleanup archived both once the item finished.
    for (const id of [builder, reviewer]) {
      env.repo.update(id, (s) => ({ ...s, archivedAt: new Date().toISOString() }));
    }
    const at = env.now().toISOString();
    env.factory.data.updateItem(created.id, (i) => ({
      ...i,
      stage: "merged",
      builderSessionId: builder,
      builderProvider: "codex",
      reviewerSessionId: reviewer,
      reviewerProvider: "claude",
      mergedAt: at,
      finishedAt: at,
    }));
    env.spendOn(builder, 1.5);
    env.spendOn(reviewer, 0.5);

    const card = await env.factory.scorecard(env.project.id, 30);
    expect(FactoryScorecard.parse(card)).toEqual(card);
    expect(card.builders).toEqual([
      expect.objectContaining({
        builder: { provider: "codex", model: "gpt-5.5" },
        merged: 1,
        firstPass: 1,
        costUsd: 2,
        costPerMergeUsd: 2,
        estimatedUsd: 2,
      }),
    ]);
    expect(card.reviewers[0]?.reviewer).toEqual({ provider: "claude", model: "claude-opus-4-5" });

    // A busy project starts many sessions after them (the session list stops at 1000): the
    // models are still those the sessions ran, not the providers' defaults.
    const newer = Date.now() + 60_000;
    const template = env.repo.get(builder);
    for (let n = 0; n < 1_001; n++) {
      const at = new Date(newer + n).toISOString();
      env.repo.create(
        {
          ...template,
          id: randomUUID(),
          startedBy: { kind: "user" },
          workKey: `request:${n}`,
          model: "other-model",
          archivedAt: null,
          createdAt: at,
          updatedAt: at,
        },
        { workspaceMode: "worktree", workspaceFallback: null, forced: null, queuedBehind: [] },
      );
    }
    expect(
      env.repo.list({ projectId: env.project.id, role: "agent" }).map((s) => s.id),
    ).not.toContain(builder);
    const later = await env.factory.scorecard(env.project.id, 30);
    expect(later.builders.map((r) => r.builder)).toEqual([{ provider: "codex", model: "gpt-5.5" }]);
    expect(later.reviewers.map((r) => r.reviewer)).toEqual([
      { provider: "claude", model: "claude-opus-4-5" },
    ]);
    // Its cost is found by the sessions the item recorded, not the capped list either.
    expect(later.builders[0]?.costUsd).toBe(2);
  });
});

describe("GET /api/projects/:id/factory/scorecard (#361)", () => {
  const empty = (days: number) => ({
    projectId: "p1",
    days,
    since: NOW.toISOString(),
    finished: 0,
    builders: [],
    reviewers: [],
    pairs: [],
  });
  const asked: number[] = [];
  const app = projectFactoryRoutes({
    factory: {
      scorecard: async (_projectId: string, days: number) => {
        asked.push(days);
        return empty(days);
      },
    },
  } as unknown as AppServices);

  it("takes 7, 30 or 90 days, 30 by default, and refuses any other window", async () => {
    for (const [query, days] of [
      ["", 30],
      ["?days=7", 7],
      ["?days=90", 90],
    ] as const) {
      const res = await app.request(`/p1/factory/scorecard${query}`);
      expect(res.status).toBe(200);
      expect(FactoryScorecard.parse(await res.json()).days).toBe(days);
    }
    expect(asked).toEqual([30, 7, 90]);
    for (const days of ["14", "0", "x"]) {
      const res = await app.request(`/p1/factory/scorecard?days=${days}`);
      expect(res.status).toBe(400);
      expect(await res.json()).toMatchObject({ error: { code: "bad_request" } });
    }
    expect(asked).toHaveLength(3);
  });
});
