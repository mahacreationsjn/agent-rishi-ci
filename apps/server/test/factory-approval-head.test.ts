import { ReviewVerdict } from "@agent-rishi/contracts";
import { afterEach, describe, expect, it } from "vitest";
import { settleApproval, verdictHead } from "../src/services/factory/approval";
import { recheckOf } from "../src/services/factory/recheck";
import { createFactoryEnv, type FactoryEnv } from "./support/factory-env";
import { APPROVE, factorySteps } from "./support/factory-steps";
import type { FakePr } from "./support/fake-factory-github";

/**
 * An approval covers one head commit (§10.1, Review and Merge, #322). Commits pushed after the
 * reviewer approved don't merge on that approval: the review check waits for a review of what
 * changed. Bringing the PR up to date with main (update-branch) keeps the approval; a conflict
 * resolution is re-checked; a head that moves just before the merge call never merges unreviewed.
 */

let env: FactoryEnv;
afterEach(() => env?.close());
const { item, tick, lastMessageTo, enable, verifying, review } = factorySteps(() => env);

const reviewCheck = (id: string) => item(id).checks.find((c) => c.name === "review");

/** The builder (or anyone with push access) pushes a commit that changes the PR's code. */
const push = (pr: FakePr, sha: string) => env.gh.push(pr, sha, ["src/network/public-fetch.ts"]);

describe("settleApproval", () => {
  const T = "2026-11-14T10:00:00.000Z";
  const approved: ReviewVerdict = ReviewVerdict.parse(APPROVE);
  const seenA = (diff: string | null) => ({
    head_A: T,
    verdict_A: T,
    asked_A: T,
    ...(diff ? { [`diff_${diff}`]: T } : {}),
  });
  const pass = (before: Record<string, string>, pr: { headSha: string; diffKey: string | null }) =>
    settleApproval(before, { ...before, head_B: T }, pr, approved, T);

  it("carries the approval to a new head with the same change as the approved one", () => {
    const next = pass(seenA("A:k1"), { headSha: "B", diffKey: "k1" });
    expect(Object.keys(next)).toEqual(
      expect.arrayContaining(["verdict_B", "asked_B", "diff_B:k1"]),
    );
    expect(verdictHead({ nudges: next })).toBe("B");
    expect(recheckOf({ nudges: next })).toBeNull();
  });

  it("owes a re-check when the change differs, can't be told, or was read for another head", () => {
    for (const [before, diffKey] of [
      [seenA("A:k1"), "k2"],
      [seenA("A:k1"), null],
      [seenA(null), "k1"],
      // A fingerprint recorded for another head never vouches for this one.
      [seenA("X:k1"), "k1"],
    ] as const) {
      const next = pass(before, { headSha: "B", diffKey });
      expect(verdictHead({ nudges: next })).toBe("A");
      expect(recheckOf({ nudges: next })).toBe("A");
      expect(next.recheck_commits_A).toBe(T);
    }
  });
});

describe("an approval covers one head commit", () => {
  it("doesn't merge a commit pushed after the approval until a re-review approves it", async () => {
    env = createFactoryEnv();
    await enable();
    const { id, pr } = await verifying("pending");
    review(id);
    await tick();
    expect(env.gh.merges).toEqual([]);
    const approved = pr.headSha as string;

    // B: a code change pushed after the approval, CI green on it.
    push(pr, "pushedB");
    await tick();
    expect(env.gh.merges).toEqual([]);
    expect(reviewCheck(id)?.state).toBe("pending");
    expect(item(id).note ?? "").toContain(`${approved.slice(0, 7)} → pushedB`);
    await tick();
    expect(env.gh.merges).toEqual([]);

    // The re-review approves B: now it merges.
    const reviewer = item(id).reviewerSessionId as string;
    expect(lastMessageTo(reviewer)).toContain("pushedB");
    review(id, { ...APPROVE, summary: "The new commits are fine" });
    await tick();
    expect(env.gh.merges.map((m) => m.number)).toEqual([pr.ref.number]);
  });

  it("keeps the approval when the merge queue only brings the PR up to date with main", async () => {
    // Under the strict policy the queue brings a PR that is behind up to date (update-branch).
    env = createFactoryEnv({ limits: { mergePolicy: "strict" } });
    await enable();
    const { id, pr } = await verifying("pending");
    env.gh.pushMain(["src/counter.ts"]);
    review(id);
    await tick();
    pr.checks = "success";
    await tick();
    expect(env.gh.updates).toHaveLength(1);
    expect(pr.headSha).not.toBe(env.gh.updates[0]?.expectedHeadSha);
    await tick();
    expect(env.gh.merges).toEqual([]);
    pr.checks = "success";
    await tick();
    expect(env.gh.merges.map((m) => m.number)).toEqual([pr.ref.number]);
    expect(env.messages.some((m) => /range-diff|re-review/i.test(m.text))).toBe(false);
  });

  it("keeps the approval on a rebase that brought only main in (the same change)", async () => {
    env = createFactoryEnv();
    await enable();
    const { id, pr } = await verifying("pending");
    review(id);
    await tick();
    env.gh.rebase(pr, "rebasedSame", "success");
    await tick();
    expect(env.gh.merges.map((m) => m.number)).toEqual([pr.ref.number]);
    expect(item(id).nudges.verdict_rebasedSame).toBeDefined();
    expect(env.messages.some((m) => /range-diff/.test(m.text))).toBe(false);
  });

  it("covers only the head the reviewer was asked about when a push lands mid-review", async () => {
    env = createFactoryEnv();
    await enable();
    const { id, pr } = await verifying("success");
    const asked = pr.headSha as string;
    expect(item(id).reviewerSessionId).toBeTruthy();
    // B lands while the reviewer still reads A; its approval then comes in.
    push(pr, "midReviewB");
    await tick();
    review(id);
    expect(item(id).nudges[`verdict_${asked}`]).toBeDefined();
    await tick();
    expect(env.gh.merges).toEqual([]);
    expect(lastMessageTo(item(id).reviewerSessionId as string)).toContain(
      `git range-diff ${asked}...midReviewB`,
    );
    review(id, { ...APPROVE, summary: "B is fine" });
    await tick();
    expect(env.gh.merges.map((m) => m.number)).toEqual([pr.ref.number]);
  });

  it("re-checks a conflict resolution that changes the PR's files before it merges", async () => {
    env = createFactoryEnv();
    await enable();
    const { id, pr, builder } = await verifying("pending");
    review(id);
    await tick();
    pr.mergeable = "conflicting";
    await tick();
    expect(lastMessageTo(builder)).toMatch(/\*\*Rebase\*\*/);

    env.gh.push(pr, "resolved1", ["src/counter-merge.ts"]);
    env.gh.rebase(pr, "resolved1", "success");
    await env.setStatus(builder, "idle");
    await tick();
    expect(reviewCheck(id)?.state).toBe("pending");
    expect(env.gh.merges).toEqual([]);

    review(id, { ...APPROVE, summary: "The resolution keeps both sides" });
    await tick();
    expect(env.gh.merges.map((m) => m.number)).toEqual([pr.ref.number]);
  });

  it("doesn't merge a head that moved between the merge decision and the merge call", async () => {
    env = createFactoryEnv();
    await enable();
    const { id, pr } = await verifying("pending");
    review(id);
    await tick();
    // The checks pass on A; a push lands just before the merge call.
    const merge = env.gh.merge.bind(env.gh);
    let moved = false;
    env.gh.merge = async (projectId, number, opts) => {
      if (!moved) {
        moved = true;
        push(pr, "lateB");
      }
      return merge(projectId, number, opts);
    };
    pr.checks = "success";
    await tick();
    expect(moved).toBe(true);
    expect(env.gh.merges).toEqual([]);

    // B has CI green but no review of its own: it stays unmerged.
    await tick();
    await tick();
    expect(env.gh.merges).toEqual([]);
    expect(reviewCheck(id)?.state).toBe("pending");
  });
});
