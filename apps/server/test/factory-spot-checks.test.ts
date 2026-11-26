import { FactorySpotCheckResponse, FOLLOW_UP_LABEL } from "@agent-rishi/contracts";
import { afterEach, describe, expect, it } from "vitest";
import { FACTORY_LABEL } from "../src/services/factory/intake";
import {
  spotCheckBucket,
  spotCheckInboxId,
  spotCheckOutstanding,
  spotCheckReason,
} from "../src/services/factory/spot-checks";
import { REVERTED_AT } from "../src/services/factory/stats";
import { createFactoryEnv, type FactoryEnv } from "./support/factory-env";
import { factorySteps } from "./support/factory-steps";

/**
 * Dark factory spot-checks (#380): a deterministic share of automatic merges, plus every merge of
 * work let in from an untrusted author or allowed past the size limit, waits for a person's quick
 * look. One inbox item per project says how many; what people find is recorded on the item, can
 * become a follow-up issue, and counts in the panel, the digest and the scorecard. Nothing ever
 * waits on a spot-check.
 */

let env: FactoryEnv;
afterEach(() => env?.close());
const s = factorySteps(() => env);

const inboxItem = () => env.inbox.find(spotCheckInboxId(env.project.id));

/** A feature built, reviewed and merged by the factory; the tick after the approval merges it. */
async function autoMerged(title: string, issue: number) {
  const { id, pr } = await s.verifying("success", title, issue);
  s.review(id);
  await s.tick();
  expect(s.item(id).stage).toBe("watching");
  return { id, pr };
}

describe("sampling (#380)", () => {
  it("puts each item in the same place every time, and a share of N picks about N in 100", () => {
    const ids = Array.from({ length: 2_000 }, (_, n) => `0b7c${n}-item-${n * 7919}`);
    expect(ids.map(spotCheckBucket)).toEqual(ids.map(spotCheckBucket));
    for (const id of ids) {
      const bucket = spotCheckBucket(id);
      expect(bucket).toBeGreaterThanOrEqual(0);
      expect(bucket).toBeLessThan(100);
    }
    const trusted = (id: string) => ({
      id,
      source: "issue" as const,
      trust: "trusted" as const,
      largeChange: null,
    });
    const picked = (share: number) =>
      ids.filter((id) => spotCheckReason(trusted(id), share, true) === "sampled").length;
    expect(picked(10) / ids.length).toBeGreaterThan(0.07);
    expect(picked(10) / ids.length).toBeLessThan(0.13);
    expect(picked(0)).toBe(0);
    expect(picked(100)).toBe(ids.length);
    // A larger share keeps every item a smaller one picked: raising it never reshuffles.
    const ten = ids.filter((id) => spotCheckReason(trusted(id), 10, true));
    const twenty = new Set(ids.filter((id) => spotCheckReason(trusted(id), 20, true)));
    expect(ten.every((id) => twenty.has(id))).toBe(true);
  });

  it("always includes untrusted-author work and large changes, never reverts, nothing at 0", () => {
    // An id outside a 1% share.
    const id = Array.from({ length: 200 }, (_, n) => `item-${n}`).find(
      (x) => spotCheckBucket(x) >= 1,
    ) as string;
    const item = { id, source: "issue" as const, trust: "trusted" as const, largeChange: null };
    expect(spotCheckReason(item, 1, true)).toBeNull();
    expect(spotCheckReason({ ...item, trust: "admitted" }, 1, true)).toBe("untrusted_author");
    expect(spotCheckReason({ ...item, largeChange: "Initial scaffold" }, 1, true)).toBe(
      "large_change",
    );
    // Merged by a person on GitHub: only the always-included cases.
    expect(spotCheckReason({ ...item, trust: "admitted" }, 1, false)).toBe("untrusted_author");
    expect(spotCheckReason({ ...item, largeChange: "Stack migration" }, 1, false)).toBe(
      "large_change",
    );
    expect(spotCheckReason(item, 100, false)).toBeNull();
    // The factory's own reverts never; a share of 0 turns it all off.
    expect(spotCheckReason({ ...item, source: "revert" }, 100, true)).toBeNull();
    expect(spotCheckReason({ ...item, trust: "admitted" }, 0, false)).toBeNull();
    expect(spotCheckReason({ ...item, largeChange: "x" }, 0, true)).toBeNull();
  });
});

describe("spot-checks in the loop (#380)", () => {
  it("sets merges aside without holding anything up, and keeps one inbox item per project", async () => {
    env = createFactoryEnv();
    s.enable("dark_factory", { tuning: { spotCheckPercent: 100 } });
    const a = await autoMerged("Add a counter", 3);
    expect(s.item(a.id).spotCheck).toMatchObject({
      reason: "sampled",
      state: "pending",
      sampledAt: s.item(a.id).mergedAt,
      checkedAt: null,
    });
    // Nothing waits on it: the merge counted, the item is watched as usual.
    expect(env.factory.data.loopOrNew(env.project.id).mergesToday).toBe(1);
    await s.tick();
    expect(s.item(a.id).stage).toBe("merged");
    expect(inboxItem()).toMatchObject({
      kind: "spot_check",
      status: "open",
      priority: "low",
      notify: "needs_you",
      title: `1 merge to spot-check (${env.project.name})`,
    });
    const b = await autoMerged("Add a timer", 4);
    await s.tick();
    // The same item, refreshed: never one per merge.
    const open = env.inbox
      .list({ projectId: env.project.id })
      .filter((x) => x.kind === "spot_check");
    expect(open).toHaveLength(1);
    expect(open[0]?.title).toBe(`2 merges to spot-check (${env.project.name})`);
    expect(open[0]?.body).toContain(`Add a timer (#${b.pr.ref.number})`);

    const status = await env.factory.status(env.project.id);
    expect(status.spotChecks).toMatchObject({ percent: 100, outstanding: 2, checked30d: 0 });
    expect(status.spotChecks.pending.map((e) => e.itemId).sort()).toEqual([a.id, b.id].sort());
    expect(status.spotChecks.pending[0]?.verdict).toEqual({
      verdict: "approve",
      summary: "Meets the criteria",
    });

    // Looks good: one left.
    const good = await env.factory.decideSpotCheck(env.project.id, a.id, { verdict: "looks_good" });
    expect(FactorySpotCheckResponse.parse(good)).toEqual(good);
    expect(good.item.spotCheck).toMatchObject({ state: "looks_good", note: null, issue: null });
    expect(good.item.spotCheck?.checkedAt).not.toBeNull();
    expect(inboxItem()?.title).toBe(`1 merge to spot-check (${env.project.name})`);

    // Found a problem: recorded, filed as a follow-up issue the factory takes on, and the inbox
    // item resolves with nothing left.
    const note = "The timer never stops when the tab is hidden";
    const bad = await env.factory.decideSpotCheck(env.project.id, b.id, {
      verdict: "problem",
      note,
      fileIssue: true,
    });
    expect(bad.issueError).toBeNull();
    const filed = env.gh.issues.find((i) => i.number === bad.item.spotCheck?.issue?.number);
    expect(filed?.title).toBe("Spot-check: Add a timer");
    expect(filed?.body).toContain(note);
    expect(filed?.body).toContain(b.pr.ref.url);
    expect(filed?.body).toContain("Meets the criteria");
    expect(filed?.labels).toEqual(expect.arrayContaining([FACTORY_LABEL, FOLLOW_UP_LABEL]));
    expect(s.item(b.id).spotCheck).toMatchObject({ state: "problem", note });
    expect(inboxItem()?.status).toBe("resolved");

    // Decided once.
    await expect(
      env.factory.decideSpotCheck(env.project.id, b.id, { verdict: "looks_good" }),
    ).rejects.toMatchObject({ code: "spot_check_not_pending" });
    await expect(env.factory.fileSpotCheckIssue(env.project.id, b.id)).rejects.toMatchObject({
      code: "spot_check_issue_filed",
    });
    await expect(env.factory.fileSpotCheckIssue(env.project.id, a.id)).rejects.toMatchObject({
      code: "spot_check_not_problem",
    });

    const after = await env.factory.status(env.project.id);
    expect(after.spotChecks).toMatchObject({ outstanding: 0, checked30d: 2, problems30d: 1 });
    expect(after.spotChecks.recent.map((e) => e.itemId)).toEqual([b.id, a.id]);

    // The digest counts them, and doesn't list the spot-check item as waiting on you.
    const digest = await env.factory.digestNow(env.project.id);
    expect(digest.spotChecks).toEqual({
      checkedToday: 2,
      problemsToday: 1,
      outstanding: 0,
      checked30d: 2,
      problems30d: 1,
    });
    expect(digest.text).toContain(
      "Spot-checks: 2 checked today (1 found a problem), 0 outstanding; over 30 days a person found a problem in 1 of 2 checked merges (50%).",
    );

    // The scorecard counts them against the builder and reviewer.
    const card = await env.factory.scorecard(env.project.id, 30);
    expect(card.builders.reduce((n, r) => n + r.spotChecked, 0)).toBe(2);
    expect(card.builders.reduce((n, r) => n + r.spotProblems, 0)).toBe(1);
    expect(card.reviewers.reduce((n, r) => n + r.spotProblems, 0)).toBe(1);
    expect(card.pairs.reduce((n, r) => n + r.spotChecked, 0)).toBe(2);
  });

  it("keeps the verdict when GitHub doesn't take the issue, and File issue files it later", async () => {
    env = createFactoryEnv();
    s.enable("dark_factory", { tuning: { spotCheckPercent: 100 } });
    const { id } = await autoMerged("Add a counter", 3);
    const createIssue = env.gh.createIssue.bind(env.gh);
    env.gh.createIssue = async () => {
      throw new Error("GitHub is down");
    };
    const res = await env.factory.decideSpotCheck(env.project.id, id, {
      verdict: "problem",
      note: "Off by one",
      fileIssue: true,
    });
    expect(res.issueError).toMatch(/GitHub is down/);
    expect(s.item(id).spotCheck).toMatchObject({
      state: "problem",
      note: "Off by one",
      issue: null,
    });
    env.gh.createIssue = createIssue;
    const filed = await env.factory.fileSpotCheckIssue(env.project.id, id);
    expect(filed.issueError).toBeNull();
    expect(s.item(id).spotCheck?.issue?.number).toBeGreaterThan(0);
  });

  it("records a problem without an issue when asked not to file one", async () => {
    env = createFactoryEnv();
    s.enable("dark_factory", { tuning: { spotCheckPercent: 100 } });
    const { id } = await autoMerged("Add a counter", 3);
    const before = env.gh.issues.length;
    await env.factory.decideSpotCheck(env.project.id, id, {
      verdict: "problem",
      note: "Naming is off",
      fileIssue: false,
    });
    expect(env.gh.issues).toHaveLength(before);
    expect(s.item(id).spotCheck).toMatchObject({ state: "problem", issue: null });
  });

  it("samples nothing by default in a software factory", async () => {
    env = createFactoryEnv();
    s.enable("software_factory", { autoMerge: true });
    const { id } = await autoMerged("Add a counter", 3);
    await s.tick();
    expect(s.item(id).spotCheck).toBeNull();
    expect(inboxItem()).toBeUndefined();
    expect((await env.factory.status(env.project.id)).spotChecks).toMatchObject({
      percent: 0,
      outstanding: 0,
      pending: [],
    });
    await expect(
      env.factory.decideSpotCheck(env.project.id, id, { verdict: "looks_good" }),
    ).rejects.toMatchObject({ code: "spot_check_not_pending" });
  });

  it("spot-checks untrusted-author work a person merged, and large changes, whatever the share", async () => {
    env = createFactoryEnv();
    s.enable("software_factory", { autoMerge: true, tuning: { spotCheckPercent: 1 } });
    // Let in from an untrusted author: the factory never merges it, a person does on GitHub.
    const ext = await s.verifying("success", "Add a theme", 5);
    env.factory.data.updateItem(ext.id, (i) => ({ ...i, trust: "admitted", admittedBy: "user" }));
    s.review(ext.id);
    await s.tick();
    expect(env.gh.merges).toHaveLength(0);
    ext.pr.ref = { ...ext.pr.ref, state: "merged" };
    await s.tick();
    expect(s.item(ext.id)).toMatchObject({ stage: "merged", note: "Merged on GitHub" });
    expect(s.item(ext.id).spotCheck).toMatchObject({
      reason: "untrusted_author",
      state: "pending",
    });

    // Allowed past the size limit, merged automatically.
    const big = await s.verifying("success", "Scaffold the app", 6);
    env.factory.data.updateItem(big.id, (i) => ({ ...i, largeChange: "Initial scaffold" }));
    s.review(big.id);
    await s.tick();
    expect(s.item(big.id).spotCheck).toMatchObject({ reason: "large_change", state: "pending" });
    expect(inboxItem()?.title).toBe(`2 merges to spot-check (${env.project.name})`);
  });

  it("withdraws a check whose merge was reverted, and waits for a new merge after a dismissal", async () => {
    env = createFactoryEnv();
    s.enable("dark_factory", { tuning: { spotCheckPercent: 100 } });
    const a = await autoMerged("Add a counter", 3);
    await s.tick();
    expect(inboxItem()?.status).toBe("open");
    // A person dismisses the item: it stays dismissed while nothing new is set aside.
    env.inbox.close(inboxItem() as NonNullable<ReturnType<typeof inboxItem>>, "dismissed", null);
    await s.tick();
    expect(inboxItem()?.status).toBe("dismissed");
    // A new merge set aside asks again.
    await new Promise((r) => setTimeout(r, 5));
    await autoMerged("Add a timer", 4);
    await s.tick();
    expect(inboxItem()).toMatchObject({ status: "open" });
    expect(inboxItem()?.title).toMatch(/^2 merges/);

    // The first merge is reverted: nothing to check any more.
    const revertAt = new Date(Date.now() + 60_000).toISOString();
    env.factory.data.updateItem(a.id, (i) => ({
      ...i,
      nudges: { ...i.nudges, [REVERTED_AT]: revertAt },
    }));
    expect(spotCheckOutstanding(s.item(a.id))).toBe(false);
    await s.tick();
    expect(inboxItem()?.title).toMatch(/^1 merge to/);
    await expect(
      env.factory.decideSpotCheck(env.project.id, a.id, { verdict: "looks_good" }),
    ).rejects.toMatchObject({ code: "spot_check_not_pending" });
    expect((await env.factory.status(env.project.id)).spotChecks.outstanding).toBe(1);
  });

  it("answers 404 for an item of another project", async () => {
    env = createFactoryEnv();
    s.enable("dark_factory", { tuning: { spotCheckPercent: 100 } });
    const { id } = await autoMerged("Add a counter", 3);
    await expect(
      env.factory.decideSpotCheck("other-project", id, { verdict: "looks_good" }),
    ).rejects.toMatchObject({ code: expect.stringMatching(/not_found/) });
  });
});
