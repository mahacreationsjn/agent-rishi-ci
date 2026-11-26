import type { FactoryItem, FactoryLimits, StartSessionRequest } from "@agent-rishi/contracts";
import { afterEach, describe, expect, it } from "vitest";
import { MAX_REVERT_STARTS } from "../src/services/factory/revert-start";
import { SlotBoard } from "../src/services/factory/slots";
import { createFactoryEnv, type FactoryEnv } from "./support/factory-env";
import { factorySteps } from "./support/factory-steps";

/**
 * An automatic revert that couldn't start (#509): its builder session failed to open, the item
 * failed, and the closed-issue check settled it as "resolved by" the very merge it was meant to
 * revert (the revert carries the reverted item's issue, which that merge closed). No revert ever
 * ran, main stayed red and the loop stayed paused for good: failed work isn't recovered while the
 * loop is paused, and only a landed revert lifted a regression's pause.
 */

let env: FactoryEnv;
afterEach(() => env?.close());

const s = factorySteps(() => env);
const loop = () => env.factory.data.loopOrNew(env.project.id);
const revertOf = (id: string) =>
  env.factory.data
    .items(env.project.id)
    .find((i) => i.source === "revert" && i.revertOf === id) as FactoryItem;
const revertStarts = () => env.starts.filter((r) => r.workKey?.startsWith("factory:revert:"));
/** Open inbox items, the daily digest left out. */
const openInbox = () =>
  env.inbox
    .list({ projectId: env.project.id })
    .filter((i) => !i.id.startsWith("inbox:factory-digest:"));

function setLimits(patch: Partial<FactoryLimits>) {
  const current = env.factory.ctx.projects.get(env.project.id).factoryLimits;
  env.updateProject({ factoryLimits: { ...current, ...patch } });
}

/** The runner refuses to open revert sessions (`session.start` timed out) while `refuse` is on. */
function refuseRevertStarts() {
  const start = env.sessions.start.bind(env.sessions);
  const runner = { refuse: true };
  env.sessions.start = async (req: StartSessionRequest) => {
    if (runner.refuse && req.workKey?.startsWith("factory:revert:")) {
      env.starts.push(req);
      throw new Error("Runner command session.start timed out");
    }
    return start(req);
  };
  return runner;
}

/**
 * A change merged by the dark factory, then CI on main fails on its merge commit. With
 * `issueClosed`, its issue is on GitHub and the merged PR closed it ("Fixes #n").
 */
async function mergedThenRed(opts: { issueClosed?: boolean } = {}) {
  s.enable("dark_factory");
  const issue = opts.issueClosed
    ? env.gh.openIssue({
        projectId: env.project.id,
        title: "Group the list",
        author: "agent-rishi",
      })
    : null;
  const created = s.backlogItem("Group the list", issue?.number);
  await s.tick();
  const builder = s.item(created.id).builderSessionId as string;
  const pr = env.gh.openPr({
    sessionId: builder,
    title: created.title,
    files: ["src/lists.ts", "test/lists.test.ts"],
  });
  if (issue) pr.linkedIssues = [issue.number];
  await env.setStatus(builder, "idle");
  await s.tick();
  await s.review(created.id);
  await s.tick();
  const merged = s.item(created.id);
  expect(merged.stage).toBe("watching");
  if (issue) env.gh.closeIssue(issue.number);
  env.gh.commitState.set(merged.mergeSha as string, "failure");
  env.gh.main.checks = "failure";
  return { id: created.id, builder, pr, issue };
}

describe("an automatic revert whose start fails (#509)", () => {
  it("still runs a revert whose issue the reverted merge closed, and resumes once it merged", async () => {
    env = createFactoryEnv();
    env.gh.canRevertViaApi = false;
    const { id, builder } = await mergedThenRed({ issueClosed: true });
    await s.tick();
    expect(loop().state).toBe("paused");
    const revert = revertOf(id);
    expect(revert).toMatchObject({ stage: "building" });
    const first = revert.builderSessionId as string;
    // The runner couldn't open the agent's session (`session.start` timed out).
    await env.setStatus(first, "failed");
    await s.tick();
    expect(s.item(revert.id)).toMatchObject({ stage: "backlog", builderSessionId: null });
    expect(s.item(revert.id).note).toMatch(/^The revert couldn't start/);
    // Not settled as "resolved by" the merge it reverts: it starts again on the next tick.
    await s.tick();
    expect(s.item(revert.id).reason ?? "").not.toMatch(/issue was closed on GitHub/);
    expect(s.item(revert.id).stage).toBe("building");
    expect(revertStarts()).toHaveLength(2);
    const agent = s.item(revert.id).builderSessionId as string;
    expect(agent).not.toBe(first);
    // The failed session is let go.
    expect(env.archived).toContain(first);
    // The fresh agent opens the revert (not an exact one: it gets the normal review), it merges,
    // and CI on main is green on it: the loop resumes and the work goes back to its builder.
    env.gh.openPr({
      sessionId: agent,
      title: `Revert "Group the list"`,
      files: ["src/lists.ts", "test/lists.test.ts"],
      body: "Reverts the merge.",
    });
    await env.setStatus(agent, "idle");
    await s.tick();
    await s.tick();
    await s.review(revert.id);
    // The reviewers end their turns: an agent is free for the revise round.
    await env.setStatus(s.item(revert.id).reviewerSessionId as string, "idle");
    await env.setStatus(s.item(id).reviewerSessionId as string, "idle");
    await s.tick();
    expect(s.item(revert.id).stage).toBe("watching");
    env.gh.main.checks = "success";
    await s.tick();
    expect(s.item(revert.id).stage).toBe("merged");
    expect(loop().state).not.toBe("paused");
    expect(env.inbox.find(`inbox:factory-regression:${id}`)?.status).toBe("resolved");
    expect(s.item(id)).toMatchObject({ stage: "building", attempts: 1 });
    expect(s.lastMessageTo(builder)).toContain("Revise (after a revert)");
  });

  it("retries a failed start on the next free agent, then asks once after the last try", async () => {
    env = createFactoryEnv();
    env.gh.canRevertViaApi = false;
    const { id, builder } = await mergedThenRed();
    await s.tick();
    const revert = revertOf(id);
    await env.setStatus(revert.builderSessionId as string, "failed");
    // No agent is free: the requeued revert waits, still first in line, and the paused loop keeps
    // it queued instead of failing it.
    await env.setStatus(s.item(id).reviewerSessionId as string, "idle");
    setLimits({ maxConcurrentSessions: 1 });
    await env.setStatus(builder, "running");
    await s.tick();
    await s.tick();
    expect(s.item(revert.id).stage).toBe("backlog");
    expect(revertStarts()).toHaveLength(1);
    // The agent frees up: the revert takes it on the next tick, and this start is refused too.
    const runner = refuseRevertStarts();
    await env.setStatus(builder, "idle");
    await s.tick();
    expect(revertStarts()).toHaveLength(2);
    expect(s.item(revert.id)).toMatchObject({ stage: "backlog" });
    expect(s.item(revert.id).note).toContain("Runner command session.start timed out");
    expect(openInbox().map((i) => i.title)).toEqual(["Factory regression on main: Group the list"]);
    // The last try fails as well: one inbox item explains it, and the loop stays paused.
    await s.tick();
    expect(revertStarts()).toHaveLength(MAX_REVERT_STARTS);
    const title = `main is red and the revert of #${s.item(id).pr?.number} couldn't start: Runner command session.start timed out`;
    expect(s.item(revert.id)).toMatchObject({
      stage: "failed",
      failureKind: "stuck",
      reason: title,
    });
    expect(loop()).toMatchObject({ state: "paused", pausedReason: title });
    const open = openInbox();
    expect(open).toHaveLength(1);
    expect(open[0]).toMatchObject({ id: `inbox:factory-regression:${id}`, title });
    expect(open[0]?.body).toMatch(/Retry the revert, or fix main by hand/);
    await s.tick();
    expect(revertStarts()).toHaveLength(MAX_REVERT_STARTS);
    // Retry starts it again, with fresh tries.
    runner.refuse = false;
    env.factory.retry(env.project.id, revert.id);
    await s.tick();
    expect(s.item(revert.id).stage).toBe("building");
    expect(revertStarts()).toHaveLength(MAX_REVERT_STARTS + 1);
  });

  it("starts the revert again when no agent could start it at the regression", async () => {
    env = createFactoryEnv();
    env.gh.canRevertViaApi = false;
    const runner = refuseRevertStarts();
    const { id } = await mergedThenRed();
    await s.tick();
    expect(loop().state).toBe("paused");
    const revert = revertOf(id);
    expect(revert).toMatchObject({ stage: "backlog", reason: null });
    runner.refuse = false;
    await s.tick();
    expect(s.item(revert.id).stage).toBe("building");
  });

  it("gives a free agent to a waiting revert before a review that waited longer", () => {
    const board = new SlotBoard();
    board.beginTick("p");
    expect(board.claim("p", "review", "review:a", 0)).toBe(false);
    board.beginTick("p");
    expect(board.claim("p", "revert", "revert:r", 1)).toBe(true);
    expect(board.claim("p", "review", "review:a", 0)).toBe(false);
    // A revert that waited goes before a review asking first on the next tick.
    board.beginTick("p");
    expect(board.claim("p", "revert", "revert:s", 0)).toBe(false);
    board.beginTick("p");
    expect(board.claim("p", "review", "review:b", 1)).toBe(false);
    expect(board.claim("p", "revert", "revert:s", 1)).toBe(true);
  });

  it("resumes a regression pause once main is green and no revert is on its way any more", async () => {
    env = createFactoryEnv();
    env.gh.revertChecks = "pending";
    const { id, builder } = await mergedThenRed();
    await s.tick();
    expect(loop().state).toBe("paused");
    const revert = revertOf(id);
    // A person closed the revert PR to fix main forward instead.
    const revertPr = env.gh.prs.get(revert.pr?.number as number);
    if (revertPr) revertPr.ref = { ...revertPr.ref, state: "closed" };
    await s.tick();
    expect(s.item(revert.id).stage).toBe("rejected");
    // Main is still red: the pause holds.
    await s.tick();
    expect(loop().state).toBe("paused");
    env.gh.pushMain(["src/lists.ts"]);
    env.gh.main.checks = "success";
    await s.tick();
    expect(loop().state).not.toBe("paused");
    expect(env.inbox.find(`inbox:factory-regression:${id}`)?.status).toBe("resolved");
    // The revert never merged: the work keeps its merge, with no revise round.
    expect(s.item(id).stage).toBe("reverted");
    expect(s.item(id).note).toMatch(/Its revert didn't merge, and CI on main is green again/);
    await s.tick();
    expect(env.messages.filter((m) => m.sessionId === builder)).toHaveLength(0);
  });

  it("sends the work back once main is green after a person merged the revert on GitHub", async () => {
    env = createFactoryEnv();
    env.gh.revertChecks = "pending";
    const { id, builder } = await mergedThenRed();
    await s.tick();
    const revert = revertOf(id);
    const revertPr = env.gh.prs.get(revert.pr?.number as number);
    if (revertPr) revertPr.ref = { ...revertPr.ref, state: "merged" };
    env.gh.main.checks = "success";
    await s.tick();
    expect(s.item(revert.id).stage).toBe("merged");
    await s.tick();
    expect(loop().state).not.toBe("paused");
    expect(s.item(id)).toMatchObject({ stage: "building", attempts: 1 });
    expect(env.messages.filter((m) => m.sessionId === builder)).toHaveLength(1);
  });
});
