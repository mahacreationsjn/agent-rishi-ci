import { afterEach, describe, expect, it } from "vitest";
import type { CommitChecks } from "../src/services/factory/github-port";
import { createFactoryEnv, type FactoryEnv } from "./support/factory-env";
import { factorySteps } from "./support/factory-steps";

/**
 * CI on the default branch after an automatic revert merged (#374): only a green run used to
 * resume the loop. No report, a run that never finishes, or a red one left it paused for good,
 * with the reverted work never sent back and nobody told.
 */

let env: FactoryEnv;
afterEach(() => env?.close());

const s = factorySteps(() => env);
const loop = () => env.factory.data.loopOrNew(env.project.id);
/**
 * Open inbox items that ask something of the user. The daily digest isn't one: moving the test
 * clock past midnight (two hours on, late in the day) raises it.
 */
const openInbox = () =>
  env.inbox
    .list({ projectId: env.project.id })
    .filter((i) => !i.id.startsWith("inbox:factory-digest:"));
const GRACE_MS = 60_000; // `ciGraceMs` in the factory test env

/**
 * A change merged by the dark factory breaks CI on main; its automatic revert merges, and CI on
 * main then reports `afterRevert` for the revert's merge commit.
 */
async function revertMerged(afterRevert: CommitChecks) {
  s.enable("dark_factory");
  const created = s.backlogItem("Group the session list");
  await s.tick();
  const builder = s.item(created.id).builderSessionId as string;
  env.gh.openPr({
    sessionId: builder,
    title: created.title,
    files: ["src/lists.ts", "test/lists.test.ts"],
    evidence: true,
  });
  await env.setStatus(builder, "idle");
  await s.tick();
  await s.review(created.id);
  await s.tick();
  const mergeSha = s.item(created.id).mergeSha as string;
  env.gh.commitState.set(mergeSha, "failure");
  await s.tick();
  expect(s.item(created.id).stage).toBe("reverted");
  const revert = env.factory.data
    .items(env.project.id)
    .find((i) => i.source === "revert" && i.revertOf === created.id);
  const revertPr = revert?.pr?.number as number;
  // The fake names a merge commit after its PR.
  const revertSha = `merge${revertPr}`;
  env.gh.commitState.set(revertSha, afterRevert);
  await s.tick();
  // Merged, and main CI on its merge commit read in the same tick.
  const merged = s.item(revert?.id as string);
  expect(merged.mergeSha).toBe(revertSha);
  if (afterRevert !== "failure") expect(merged.stage).toBe("watching");
  expect(loop().state).toBe("paused");
  return { id: created.id, builder, revertId: merged.id, revertPr, revertSha };
}

describe("CI on main after an automatic revert (#374)", () => {
  it("tells the user when CI on main never reports for the revert, and keeps the loop paused", async () => {
    env = createFactoryEnv();
    const { id, revertId, revertPr } = await revertMerged("none");
    await s.tick();
    // Past the grace: CI on the revert's merge commit is read once more before anyone is asked.
    s.later(GRACE_MS + 1);
    await s.tick();
    expect(s.item(revertId)).toMatchObject({ stage: "watching" });
    expect(s.item(revertId).note).toMatch(/checking once more/);
    expect(openInbox().map((i) => i.title)).toEqual([
      "Factory regression on main: Group the session list",
    ]);
    // Still nothing: one inbox item, the loop stays paused, and the revert is still watched.
    s.later(GRACE_MS + 1);
    await s.tick();
    await s.tick();
    expect(loop().state).toBe("paused");
    const open = openInbox();
    expect(open).toHaveLength(1);
    expect(open[0]).toMatchObject({ id: `inbox:factory-regression:${id}`, priority: "high" });
    expect(open[0]?.title).toBe(
      `main is red or unverified after revert #${revertPr}: CI didn't report`,
    );
    expect(open[0]?.body).toMatch(/resume the loop once main is green/);
    expect(s.item(revertId).stage).toBe("watching");
    expect(s.item(id).stage).toBe("reverted");
  });

  it("tells the user when CI on main never finishes for the revert", async () => {
    env = createFactoryEnv();
    const { revertPr } = await revertMerged("pending");
    await s.tick();
    s.later(loop().tuning.watchTimeoutMin * 60_000 + 1);
    await s.tick();
    s.later(GRACE_MS + 1);
    await s.tick();
    expect(loop().state).toBe("paused");
    const open = openInbox();
    expect(open).toHaveLength(1);
    expect(open[0]?.title).toBe(
      `main is red or unverified after revert #${revertPr}: CI didn't finish`,
    );
  });

  it("resumes and sends the work back once when CI on main turns green late", async () => {
    env = createFactoryEnv();
    const { id, builder, revertSha } = await revertMerged("none");
    s.later(GRACE_MS + 1);
    await s.tick();
    s.later(GRACE_MS + 1);
    await s.tick();
    expect(openInbox()).toHaveLength(1);
    // CI on main finally reports, green.
    env.gh.commitState.set(revertSha, "success");
    await s.tick();
    expect(loop().state).not.toBe("paused");
    expect(openInbox()).toHaveLength(0);
    expect(s.item(id)).toMatchObject({ stage: "building", attempts: 1 });
    const sent = env.messages.filter((m) => m.sessionId === builder).length;
    await s.tick();
    expect(env.messages.filter((m) => m.sessionId === builder)).toHaveLength(sent);
  });

  it("sends the work back once when the user resumes the loop after CI on main never reported", async () => {
    env = createFactoryEnv();
    const { id, builder, revertId, revertSha } = await revertMerged("none");
    s.later(GRACE_MS + 1);
    await s.tick();
    s.later(GRACE_MS + 1);
    await s.tick();
    expect(loop().state).toBe("paused");
    await env.factory.resume(env.project.id);
    expect(openInbox()).toHaveLength(0);
    expect(s.item(revertId).stage).toBe("merged");
    await s.tick();
    expect(s.item(id)).toMatchObject({ stage: "building", attempts: 1 });
    const sent = env.messages.filter((m) => m.sessionId === builder).length;
    // A green run after the resume doesn't send it back again.
    env.gh.commitState.set(revertSha, "success");
    await s.tick();
    await env.factory.resume(env.project.id);
    await s.tick();
    expect(env.messages.filter((m) => m.sessionId === builder)).toHaveLength(sent);
    expect(s.item(id).attempts).toBe(1);
  });

  it("raises one inbox item when CI on main is red on the revert's merge commit", async () => {
    env = createFactoryEnv();
    const { id, builder, revertId, revertPr } = await revertMerged("failure");
    await s.tick();
    await s.tick();
    expect(loop().state).toBe("paused");
    expect(s.item(revertId).stage).toBe("merged");
    const open = openInbox();
    expect(open.map((i) => i.title)).toEqual([
      `main is still red after revert #${revertPr}: CI fails on its merge commit (test)`,
    ]);
    expect(open[0]?.id).toBe(`inbox:factory-regression:${id}`);
    // The user gets main green and resumes: the work goes back to its builder once.
    await env.factory.resume(env.project.id);
    await s.tick();
    expect(s.item(id)).toMatchObject({ stage: "building", attempts: 1 });
    expect(env.messages.filter((m) => m.sessionId === builder)).toHaveLength(1);
  });
});
