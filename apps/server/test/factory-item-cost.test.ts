import type { FactoryItem, FactoryLimits, StartedBy } from "@agent-rishi/contracts";
import { afterEach, describe, expect, it } from "vitest";
import { FACTORY_STARTER } from "../src/services/factory/sessions";
import { stuckDecisionId, stuckInboxId } from "../src/services/factory/stuck";
import { createFactoryEnv, type FactoryEnv } from "./support/factory-env";
import { APPROVE, factorySteps } from "./support/factory-steps";

/**
 * What each factory item cost and the optional per-item spend cap (#325): every session that
 * worked on an item counts toward its cost, from the usage ledger, and an item that reaches the
 * cap stops for a person.
 */

let env: FactoryEnv;
afterEach(() => env?.close());
const { item, tick, enable, backlogItem, verifying, review, failed, readAgainSoon } = factorySteps(
  () => env,
);

const capped = (itemBudget: FactoryLimits["itemBudget"]) =>
  createFactoryEnv({ limits: { itemBudget } });
const status = () => env.factory.status(env.project.id);
const workItem = async (id: string) => {
  const s = await status();
  return [...s.backlog, ...s.inProgress, ...s.recent].find((w) => w.id === id);
};
const daysAgo = (n: number) => new Date(Date.now() - n * 86_400_000).toISOString();

/** A factory session with this work key, as the factory starts one. */
async function factorySession(
  workKey: string,
  startedBy: StartedBy = FACTORY_STARTER,
): Promise<string> {
  const res = await env.sessions.start({
    projectId: env.project.id,
    role: "agent",
    startedBy,
    workKey,
  } as Parameters<FactoryEnv["sessions"]["start"]>[0]);
  if (res.status !== "started") throw new Error("not started");
  await env.setStatus(res.sessionId, "idle");
  return res.sessionId;
}

describe("an item's cost (#325)", () => {
  it("keeps every session that worked on the item and sums their ledger turns", async () => {
    env = createFactoryEnv();
    env.billing = { claude: "subscription" };
    await enable();
    const { id, builder } = await verifying();
    const reviewer = item(id).reviewerSessionId as string;
    expect(reviewer).toBeTruthy();

    // The reviewer is let go and replaced, as when its environment couldn't verify the PR.
    env.factory.data.updateItem(id, (i) => ({ ...i, reviewerSessionId: null }));
    const reviewer2 = await factorySession(`factory:review:${item(id).pr?.number}`);
    env.factory.data.updateItem(id, (i) => ({ ...i, reviewerSessionId: reviewer2 }));
    // An integrator takes the PR over from the builder.
    const integrator = await factorySession(`factory:integrate:${item(id).pr?.number}`);
    env.factory.data.updateItem(id, (i) => ({ ...i, builderSessionId: integrator }));
    // Then it fails and a person retries it from the start.
    failed(id);
    env.factory.data.updateItem(id, (i) => ({ ...i, pr: null }));
    env.factory.retry(env.project.id, id, "rebuild");
    await tick();
    const builder2 = item(id).builderSessionId as string;
    expect(builder2).toBeTruthy();
    expect(item(id).reviewerSessionId).toBeNull();

    expect(new Set(item(id).sessionIds)).toEqual(
      new Set([builder, reviewer, reviewer2, integrator, builder2]),
    );

    env.spendOn(builder, 1, { ts: daysAgo(3) }); // all time, not just today
    env.spendOn(reviewer, 0.5, { costSource: "reported" });
    env.spendOn(reviewer2, 0.25);
    env.spendOn(integrator, 2);
    env.spendOn(builder2, 0.1);
    // Another item's session doesn't count.
    const other = await factorySession("issue:99");
    env.spendOn(other, 50);

    const cost = (await workItem(id))?.cost;
    expect(cost).toMatchObject({
      usd: 3.85,
      estimatedUsd: 3.35,
      tokens: 385_000,
      turns: 5,
      sessions: 5,
      unpricedTurns: 0,
      apiEquivalent: true,
      cap: null,
    });
    // The item endpoint reports the same.
    const res = await env.factory.itemResponse(env.project.id, item(id));
    expect(res.cost).toEqual(cost);
  });

  it("finds the sessions of an item saved before it kept them, by work key", async () => {
    env = createFactoryEnv();
    await enable();
    const created = backlogItem("Older work", 7);
    // As written by an older version: no `sessionIds`, its sessions long cleared from the item.
    const { sessionIds: _ids, ...old } = env.factory.data.updateItem(created.id, (i) => ({
      ...i,
      stage: "merged",
      pr: { number: 41, url: "https://github.com/acme/app/pull/41", state: "merged" },
    }));
    env.store.append([
      { type: "factory.item.updated", sessionId: null, payload: { item: old as FactoryItem } },
    ]);
    expect(item(created.id).sessionIds).toEqual([]);

    const builder = await factorySession("issue:7");
    const reviewer = await factorySession("factory:review:41");
    const earlyReviewer = await factorySession(`factory:review:${created.id}`);
    const integrator = await factorySession("factory:integrate:41");
    // A session a person started for the same issue isn't the factory's.
    const mine = await factorySession("issue:7", { kind: "user" });
    for (const s of [builder, reviewer, earlyReviewer, integrator]) env.spendOn(s, 1);
    env.spendOn(mine, 100);

    const res = await env.factory.itemResponse(env.project.id, item(created.id));
    expect(res.cost).toMatchObject({ usd: 4, sessions: 4, apiEquivalent: false });
  });

  it("reports no cost before an agent worked on an item", async () => {
    env = createFactoryEnv();
    await enable();
    const created = backlogItem();
    const res = await env.factory.itemResponse(env.project.id, created);
    expect(res.cost).toMatchObject({ usd: 0, tokens: 0, turns: 0, sessions: 0 });
  });
});

describe("the per-item spend cap (#325)", () => {
  it("stops an item that reaches its cap and leaves it for a person", async () => {
    env = capped({ usd: 5 });
    await enable();
    const { id, builder } = await verifying();
    const reviewer = item(id).reviewerSessionId as string;
    expect(env.repo.get(reviewer).status).toBe("running");

    env.spendOn(builder, 2.5);
    env.spendOn(reviewer, 2.4);
    await tick();
    expect(item(id).stage).toBe("verifying");
    expect((await workItem(id))?.cost?.cap).toEqual({
      usd: 5,
      tokens: null,
      spentUsd: 4.9,
      spentTokens: 490_000,
    });

    env.spendOn(reviewer, 0.2);
    await tick();
    expect(item(id)).toMatchObject({
      stage: "failed",
      failureKind: "stuck",
      reason: "Spend cap reached: $5.10 of $5.00 for this item",
    });
    // Its running reviewer was stopped; the idle builder had nothing to stop.
    expect(env.stopped).toContain(reviewer);
    expect(env.stopped).not.toContain(builder);
    expect(env.inbox.find(stuckInboxId(id))).toMatchObject({
      status: "open",
      body: expect.stringMatching(/retry the item to give it a fresh \$5\.00/),
    });
    // Not a failure of its work: the streak that pauses the loop doesn't grow.
    expect(env.factory.data.loop(env.project.id)?.consecutiveFailures).toBe(0);
  });

  it("caps tokens too, and records the decision in a dark factory", async () => {
    env = capped({ tokens: 1_000 });
    await enable("dark_factory");
    const created = backlogItem();
    await tick();
    const builder = item(created.id).builderSessionId as string;
    expect(item(created.id).stage).toBe("building");
    env.spendOn(builder, 0, { tokens: 1_500, costSource: "unpriced" });
    await tick();
    expect(item(created.id)).toMatchObject({
      stage: "failed",
      failureKind: "stuck",
      reason: "Spend cap reached: 1,500 of 1,000 tokens for this item",
    });
    expect(env.stopped).toContain(builder);
    expect(env.inbox.find(stuckDecisionId(created.id))?.status).toBe("open");
  });

  it("never stops an item for its spend without a cap", async () => {
    env = createFactoryEnv();
    await enable();
    const created = backlogItem();
    await tick();
    const builder = item(created.id).builderSessionId as string;
    env.spendOn(builder, 1_000, { tokens: 1e9 });
    await tick();
    expect(item(created.id).stage).toBe("building");
    expect(env.stopped).toEqual([]);
    expect((await workItem(created.id))?.cost?.cap).toBeNull();
  });

  it("gives a retried item a fresh allowance, while its cost still shows everything", async () => {
    env = capped({ usd: 5 });
    await enable();
    const created = backlogItem();
    await tick();
    const builder = item(created.id).builderSessionId as string;
    env.spendOn(builder, 6, { ts: daysAgo(1) });
    await tick();
    expect(item(created.id).failureKind).toBe("stuck");

    env.factory.retry(env.project.id, created.id);
    expect(item(created.id).itemBudgetSince).not.toBeNull();
    await tick();
    expect(item(created.id).stage).toBe("building");
    const builder2 = item(created.id).builderSessionId as string;
    expect(builder2).not.toBe(builder);
    env.spendOn(builder2, 4);
    await tick();
    expect(item(created.id).stage).toBe("building");
    expect((await workItem(created.id))?.cost).toMatchObject({
      usd: 10,
      cap: { usd: 5, spentUsd: 4 },
    });
    env.spendOn(builder2, 1.5);
    await tick();
    expect(item(created.id)).toMatchObject({ stage: "failed", failureKind: "stuck" });
  });

  it("gives a re-reviewed item a fresh allowance too", async () => {
    env = capped({ usd: 5 });
    await enable();
    const { id, builder } = await verifying();
    env.spendOn(builder, 6, { ts: daysAgo(1) });
    await tick();
    expect(item(id).failureKind).toBe("stuck");
    // Its PR is still open: Retry sends it back to a fresh review.
    env.factory.retry(env.project.id, id, "rereview");
    expect(item(id).stage).toBe("verifying");
    await tick();
    expect(item(id).stage).toBe("verifying");
    expect(item(id).reviewerSessionId).toBeTruthy();
  });

  /** Verification whose review turn takes the item over its $5.00 cap ($4.70 + $0.40). */
  async function reviewedOverCap(checks: "success" | "pending", verdict = APPROVE) {
    env = capped({ usd: 5 });
    await enable();
    const v = await verifying(checks);
    const reviewer = item(v.id).reviewerSessionId as string;
    env.spendOn(v.builder, 4.7);
    env.spendOn(reviewer, 0.4);
    review(v.id, verdict);
    return { ...v, reviewer };
  }

  it("merges approved work its review took over the cap: merging spends nothing (#415)", async () => {
    const { id, reviewer } = await reviewedOverCap("success");
    // The verdict lands mid-turn: the reviewer still at work is stopped, the work goes on.
    expect(env.repo.get(reviewer).status).toBe("running");
    await tick();
    expect(env.stopped).toEqual([reviewer]);
    expect(item(id)).toMatchObject({ stage: "watching", reason: null, failureKind: null });
    expect(env.gh.merges).toHaveLength(1);
  });

  it("lets approved work over its cap wait on CI, then merge (#415)", async () => {
    const { id, pr, reviewer } = await reviewedOverCap("pending");
    await env.setStatus(reviewer, "idle");
    await tick();
    await tick();
    expect(item(id)).toMatchObject({ stage: "verifying", failureKind: null });
    pr.checks = "success";
    await tick();
    expect(item(id).stage).toBe("watching");
    expect(env.gh.merges).toHaveLength(1);
  });

  it("starts no revise round for work over its cap whose review asked for changes (#415)", async () => {
    const changes = { ...APPROVE, verdict: "request_changes" as const, summary: "Missing a test" };
    const { id, builder, reviewer } = await reviewedOverCap("success", changes);
    await env.setStatus(reviewer, "idle");
    const messages = env.messages.length;
    await tick();
    expect(item(id)).toMatchObject({
      stage: "failed",
      failureKind: "stuck",
      attempts: 0,
      reason: "Spend cap reached: $5.10 of $5.00 for this item",
      note: expect.stringMatching(/starts no agent work on it until it is retried$/),
    });
    expect(env.messages.slice(messages).filter((m) => m.sessionId === builder)).toEqual([]);
    expect(env.inbox.find(stuckInboxId(id))?.status).toBe("open");
  });

  it("asks no agent to rebase approved work over its cap that conflicts (#415)", async () => {
    const { id, pr, reviewer } = await reviewedOverCap("pending");
    await env.setStatus(reviewer, "idle");
    await tick();
    expect(item(id).stage).toBe("verifying");
    const starts = env.starts.length;
    const messages = env.messages.length;
    pr.mergeable = "conflicting";
    await tick();
    expect(item(id)).toMatchObject({ stage: "failed", failureKind: "stuck" });
    expect(env.starts.length).toBe(starts);
    expect(env.messages.length).toBe(messages);
  });

  it("starts no rebase, integrator or re-review for a failed item over its cap", async () => {
    env = capped({ usd: 5 });
    await enable("dark_factory");
    const { id, pr, builder } = await verifying();
    failed(id);
    await env.setStatus(item(id).reviewerSessionId as string, "idle");
    await tick();
    env.spendOn(builder, 6);
    const starts = env.starts.length;
    const messages = env.messages.length;

    // Conflicting: no request to rebase, no integrator, no rebuild.
    pr.mergeable = "conflicting";
    readAgainSoon(id);
    await tick();
    expect(item(id).stage).toBe("failed");
    expect(item(id).note).toMatch(
      /^Spend cap reached: \$6\.00 of \$5\.00 for this item: .*retried/,
    );

    // A new head past its last review, CI green: no automatic re-review either.
    env.gh.rebase(pr, "fixed-after-review");
    readAgainSoon(id);
    await tick();
    expect(item(id).stage).toBe("failed");
    expect(env.starts.length).toBe(starts);
    expect(env.messages.length).toBe(messages);
  });
});
