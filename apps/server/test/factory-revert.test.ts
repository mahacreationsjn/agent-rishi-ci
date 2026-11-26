import type { FactoryItem, MergeCheck } from "@agent-rishi/contracts";
import { afterEach, describe, expect, it } from "vitest";
import { createFactoryEnv, type FactoryEnv } from "./support/factory-env";
import { factorySteps } from "./support/factory-steps";

let env: FactoryEnv;
afterEach(() => env?.close());

const s = factorySteps(() => env);
const loop = () => env.factory.data.loopOrNew(env.project.id);
const revertOf = (id: string) =>
  env.factory.data
    .items(env.project.id)
    .find((i) => i.source === "revert" && i.revertOf === id) as FactoryItem;
const checksOf = (id: string) =>
  Object.fromEntries(s.item(id).checks.map((c) => [c.name, c])) as Record<string, MergeCheck>;
const openInbox = () => env.inbox.list({ projectId: env.project.id });

/** UI files, server code and its test: the shape of the change in the report (#350). */
const FILES = [
  "apps/web/src/components/shell/lists.tsx",
  "apps/web/src/components/command-palette.tsx",
  "apps/server/src/services/session-fork.ts",
  "apps/server/test/session-fork.test.ts",
];

/** A change with UI files, merged by the dark factory and watched on main, whose CI then fails. */
async function mergedThenRed() {
  s.enable("dark_factory");
  const created = s.backlogItem("Group the session list");
  await s.tick();
  const builder = s.item(created.id).builderSessionId as string;
  const pr = env.gh.openPr({
    sessionId: builder,
    title: created.title,
    files: FILES,
    evidence: true,
  });
  await env.setStatus(builder, "idle");
  await s.tick();
  await s.review(created.id);
  await s.tick();
  const merged = s.item(created.id);
  expect(merged.stage).toBe("watching");
  env.gh.commitState.set(merged.mergeSha as string, "failure");
  env.gh.commitFailures.set(merged.mergeSha as string, ["test (session-fork)"]);
  return { id: created.id, builder, pr };
}

describe("factory reverts (§10.1, Merge)", () => {
  it("merges a revert on its own CI without test results or screenshots, then resumes and sends the work back", async () => {
    env = createFactoryEnv();
    env.gh.revertChecks = "pending";
    const { id, builder, pr } = await mergedThenRed();
    await s.tick();
    expect(s.item(id)).toMatchObject({
      stage: "reverted",
      reason: "CI on main failed after the merge (test (session-fork))",
    });
    expect(loop().state).toBe("paused");
    const revert = revertOf(id);
    expect(revert).toMatchObject({ stage: "verifying", reason: null });
    // The revert's own rules: CI is its test evidence, no screenshots, size not counted, and an
    // automated tree comparison instead of an agent review.
    let checks = checksOf(revert.id);
    expect(checks.test_results).toMatchObject({ state: "pending" });
    expect(checks.ui_evidence).toMatchObject({ state: "skipped" });
    expect(checks.size).toMatchObject({ state: "skipped" });
    expect(checks.review?.state).toBe("pass");
    expect(checks.review?.detail).toMatch(/Automated revert check/);
    const reviewKey = `factory:review:${revert.pr?.number}`;
    expect(env.starts.some((r) => r.workKey === reviewKey)).toBe(false);
    const revertPr = env.gh.prs.get(revert.pr?.number ?? 0);
    expect(revertPr?.body).not.toMatch(/test results/i);
    // CI on the revert must pass before it merges.
    await s.tick();
    expect(s.item(revert.id).stage).toBe("verifying");
    expect(env.gh.merges.map((m) => m.number)).toEqual([pr.ref.number]);
    if (revertPr) revertPr.checks = "success";
    await s.tick();
    checks = checksOf(revert.id);
    expect(checks.test_results).toMatchObject({ state: "pass" });
    expect(s.item(revert.id).stage).toBe("watching");
    expect(env.gh.merges.map((m) => m.number)).toEqual([pr.ref.number, revertPr?.ref.number]);
    // CI on main is green on the revert: the loop resumes and the work goes back to its builder.
    await s.tick();
    expect(s.item(revert.id).stage).toBe("merged");
    expect(loop().state).not.toBe("paused");
    expect(env.inbox.find(`inbox:factory-regression:${id}`)?.status).toBe("resolved");
    const back = s.item(id);
    expect(back).toMatchObject({ stage: "building", attempts: 1, finishedAt: null });
    // The reverted merge still counts in the figures.
    expect((await env.factory.status(env.project.id)).stats).toMatchObject({ revertedToday: 1 });
    expect(back.note).toMatch(/^Revise round 1 after the revert: CI on main failed after #\d+/);
    expect(back.note).toContain(`#${revertPr?.ref.number}`);
    const brief = s.lastMessageTo(builder);
    expect(brief).toContain("Revise (after a revert)");
    expect(brief).toContain("test (session-fork)");
    expect(brief).toContain(`git revert --no-edit merge${revertPr?.ref.number}`);
    const messages = env.messages.length;
    await s.tick();
    expect(env.messages.length).toBe(messages);
    // The builder's new PR is verified like any revise round.
    const next = env.gh.openPr({
      sessionId: builder,
      title: back.title,
      files: FILES,
      evidence: true,
    });
    env.repo.update(builder, (b) => ({ ...b, pr: next.ref }));
    await env.setStatus(builder, "idle");
    await s.tick();
    expect(s.item(id)).toMatchObject({ stage: "verifying", pr: { number: next.ref.number } });
  });

  it("gives a revert that isn't exact (conflicts resolved by an agent) the normal review", async () => {
    env = createFactoryEnv();
    env.gh.canRevertViaApi = false;
    const { id } = await mergedThenRed();
    await s.tick();
    const revert = revertOf(id);
    expect(revert.stage).toBe("building");
    const agent = revert.builderSessionId as string;
    env.gh.openPr({
      sessionId: agent,
      title: `Revert "${s.item(id).title}"`,
      files: FILES,
      body: "Reverts #101, resolving a conflict in lists.tsx.",
    });
    await env.setStatus(agent, "idle");
    await s.tick();
    await s.tick();
    const checks = checksOf(revert.id);
    expect(checks.review).toMatchObject({ state: "pending" });
    const reviewKey = `factory:review:${s.item(revert.id).pr?.number}`;
    expect(env.starts.some((r) => r.workKey === reviewKey)).toBe(true);
    expect(checks.test_results).toMatchObject({ state: "pass" });
    expect(checks.ui_evidence).toMatchObject({ state: "skipped" });
    await s.review(revert.id);
    await s.tick();
    expect(s.item(revert.id).stage).toBe("watching");
  });

  it("raises one inbox item and stays paused when CI is red on the revert too", async () => {
    env = createFactoryEnv();
    env.gh.revertChecks = "failure";
    const { id, builder } = await mergedThenRed();
    await s.tick();
    await s.tick();
    await s.tick();
    const revert = s.item(revertOf(id).id);
    expect(revert).toMatchObject({ stage: "failed", failureKind: "stuck" });
    expect(revert.reason).toBe(
      "main is red and the revert can't merge: CI failed on the revert too (test)",
    );
    expect(loop()).toMatchObject({ state: "paused", pausedReason: revert.reason });
    const open = openInbox();
    expect(open).toHaveLength(1);
    expect(open[0]).toMatchObject({
      id: `inbox:factory-regression:${id}`,
      title: "main is red and the revert can't merge: CI failed on the revert too (test)",
      priority: "high",
    });
    expect(env.gh.merges).toHaveLength(1);
    expect(s.item(id).stage).toBe("reverted");
    expect(env.messages.filter((m) => m.sessionId === builder)).toHaveLength(0);
  });
});
