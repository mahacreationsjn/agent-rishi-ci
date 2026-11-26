import { afterEach, describe, expect, it } from "vitest";
import { CLEAN_REVIEW } from "../src/services/factory/review-environment";
import { createFactoryEnv, type FactoryEnv } from "./support/factory-env";
import { factorySteps } from "./support/factory-steps";

/**
 * Issue #480: when an infrastructure failure goes back to the queue because its builder is gone
 * (`recover.ts`), the item's reviewer is let go with it. Like every other path that lets a
 * reviewer go, it must become an earlier session of the item, so cleanup archives it (and its
 * worktree) instead of leaving it in the sidebar forever.
 */

let env: FactoryEnv;
afterEach(() => env?.close());
const steps = factorySteps(() => env);
const { item, enable, backlogItem, openPr, review } = steps;
/** One loop step, then the archives it queued. */
const tick = async () => {
  const loop = await steps.tick();
  await env.factory.archiver.idle();
  return loop;
};
const session = (id: string) => env.repo.get(id);

describe("recovery back to the queue after the builder is gone (#480)", () => {
  it("records the let-go reviewer as an earlier session, so it is archived", async () => {
    env = createFactoryEnv();
    enable();
    const created = backlogItem();
    // The item's reviews run in a clean worktree on the PR's head, not the builder's.
    env.factory.data.updateItem(created.id, (i) => ({
      ...i,
      nudges: { ...i.nudges, [CLEAN_REVIEW]: new Date().toISOString() },
    }));
    await tick();
    const { pr, builder } = await openPr(created.id);
    await tick();
    expect(item(created.id).stage).toBe("verifying");
    const reviewer = item(created.id).reviewerSessionId as string;
    expect(session(reviewer).worktreePath).toBeTruthy();
    expect(session(reviewer).worktreePath).not.toBe(session(builder).worktreePath);
    await env.setStatus(reviewer, "idle");

    // An infrastructure failure with no open pull request and its builder gone (stopped, with
    // no open PR of its own), while the item still records its reviewer.
    pr.ref = { ...pr.ref, state: "closed" };
    await env.setStatus(builder, "stopped");
    env.factory.data.updateItem(created.id, (i) => ({
      ...i,
      stage: "failed",
      pr: null,
      reason: "The builder session is gone",
      failureKind: "infrastructure",
      finishedAt: new Date().toISOString(),
    }));

    // Back in the queue, where a fresh builder takes it (in the same tick when one is free).
    await tick();
    const requeued = item(created.id);
    expect(["backlog", "building"]).toContain(requeued.stage);
    expect(requeued.builderSessionId).not.toBe(builder);
    expect(requeued.reviewerSessionId).toBeNull();
    // The reviewer let go is an earlier session of the item (or already archived as one).
    expect([...requeued.earlierSessionIds, ...env.archived]).toContain(reviewer);

    // A fresh builder and reviewer take the work to a merge.
    if (requeued.stage === "backlog") await tick();
    const builder2 = item(created.id).builderSessionId as string;
    expect(builder2).toBeTruthy();
    expect(builder2).not.toBe(builder);
    await openPr(created.id);
    await tick();
    const reviewer2 = item(created.id).reviewerSessionId as string;
    expect(reviewer2).toBeTruthy();
    expect(reviewer2).not.toBe(reviewer);
    review(created.id);
    await env.setStatus(reviewer2, "idle");
    await tick();
    await tick();
    expect(item(created.id).stage).toBe("merged");

    // Every session of the item is archived, the first reviewer's own worktree included.
    expect([...env.archived].sort()).toEqual([builder, reviewer, builder2, reviewer2].sort());
    expect(session(reviewer).worktreeRemovedAt).not.toBeNull();
  });
});
