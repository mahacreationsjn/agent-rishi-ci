import {
  type FactoryAnalysisReport,
  type FactoryItem,
  ReviewVerdict,
} from "@agent-rishi/contracts";
import { afterEach, describe, expect, it } from "vitest";
import { createFactoryEnv, type FactoryEnv } from "./support/factory-env";
import { APPROVE } from "./support/factory-steps";

/**
 * Issue #367: `create_pull_request` is refused while a spec waits for approval or is being revised
 * (#365), but a pull request found on the builder's branch (one it opened with `gh pr create`, or
 * one opened by hand) must not carry the item past the spec approval either. It waits, is told so
 * once, is adopted after the approval, and is closed when the work stops without one.
 */

let env: FactoryEnv;
afterEach(() => env?.close());

const enable = () =>
  env.factory.setMode(env.project.id, {
    mode: "software_factory",
    limits: env.project.factoryLimits,
    tuning: { specApproval: true, minBacklog: 0 },
  });
const tick = () => env.factory.tick(env.project.id);
const item = (id: string) => env.factory.data.item(id) as FactoryItem;
const byIssue = (number: number) =>
  env.factory.data.items(env.project.id).find((i) => i.issue?.number === number) as FactoryItem;
const builderOf = (id: string) => env.repo.get(item(id).builderSessionId as string);

const SPEC: FactoryAnalysisReport = {
  decision: "implement",
  summary: "No export yet",
  spec: "An Export button that downloads the tasks as CSV",
  acceptanceCriteria: ["Export downloads a CSV of all tasks"],
};

async function feature(): Promise<{ id: string; issue: number }> {
  const issue = env.gh.openIssue({
    projectId: env.project.id,
    title: "Add CSV export",
    author: "agent-rishi",
    labels: ["enhancement"],
  });
  await tick();
  return { id: byIssue(issue.number).id, issue: issue.number };
}

async function submit(id: string) {
  await env.factory.submitAnalysis(builderOf(id), SPEC);
  await env.setStatus(builderOf(id).id, "idle");
}

/** A pull request on the builder's branch that Agent Rishi didn't open (`gh pr create`, or by hand). */
function prOnBranch(id: string) {
  const pr = env.gh.openPr({
    sessionId: null,
    title: "Add CSV export",
    files: ["src/export.ts", "test/export.test.ts"],
  });
  pr.headBranch = builderOf(id).branch as string;
  return pr;
}

const waitingComments = (prNumber: number, issue: number) =>
  env.gh.comments.filter(
    (c) =>
      c.number === prNumber &&
      c.body.includes(`Waiting for spec approval on #${issue}`) &&
      c.body.includes("this PR won't be reviewed or merged until then"),
  );

const EARLY = "A pull request was opened before the spec was approved";

/** A person asks for changes, and the loop sends them to the builder. */
async function requestChanges(id: string) {
  await env.factory.decideSpec(env.project.id, id, {
    decision: "request_changes",
    feedback: "Also offer JSON",
  });
  await tick();
  expect(item(id).specApproval?.sentAt).not.toBeNull();
}

describe("a pull request opened before the spec was approved (#367)", () => {
  it("isn't adopted while the spec waits; after the approval it is adopted and reviewed", async () => {
    env = createFactoryEnv();
    enable();
    const { id, issue } = await feature();
    await submit(id);
    expect(item(id).specApproval?.state).toBe("pending");

    const pr = prOnBranch(id);
    await tick();
    await tick();
    expect(item(id).stage).toBe("building");
    expect(item(id).pr).toBeNull();
    expect(item(id).note).toContain(EARLY);
    expect(waitingComments(pr.ref.number, issue)).toHaveLength(1);

    // Approved: the builder gets the Implement step, ends its turn, and the PR is adopted.
    await env.factory.decideSpec(env.project.id, id, { decision: "approve" });
    await tick();
    expect(item(id).stage).toBe("building");
    await env.setStatus(builderOf(id).id, "idle");
    await tick();
    expect(item(id).stage).toBe("verifying");
    expect(item(id).pr?.number).toBe(pr.ref.number);
    expect(item(id).reviewerSessionId).toBeTruthy();
    const reviewer = env.repo.get(item(id).reviewerSessionId as string);
    await env.factory.submitReview(reviewer, ReviewVerdict.parse(APPROVE));
    expect(item(id).review?.verdict).toBe("approve");
    expect(env.gh.closed).toEqual([]);
    expect(waitingComments(pr.ref.number, issue)).toHaveLength(1);
  });

  it("isn't adopted while the builder revises the spec at a person's request", async () => {
    env = createFactoryEnv();
    enable();
    const { id, issue } = await feature();
    await submit(id);
    await requestChanges(id);

    // The revising builder opens a pull request with `gh pr create` and ends its turn.
    const pr = prOnBranch(id);
    await env.setStatus(builderOf(id).id, "idle");
    await tick();
    await tick();
    expect(item(id).stage).toBe("building");
    expect(item(id).pr).toBeNull();
    expect(item(id).note).toContain(EARLY);
    expect(waitingComments(pr.ref.number, issue)).toHaveLength(1);
  });

  it("isn't adopted by the recovery of a builder that died while revising the spec", async () => {
    env = createFactoryEnv();
    enable();
    const { id, issue } = await feature();
    await submit(id);
    await requestChanges(id);
    // The builder's session dies while it revises; a pull request shows up on its branch.
    await env.setStatus(builderOf(id).id, "failed");
    await tick();
    expect(item(id)).toMatchObject({ stage: "failed", failureKind: "infrastructure" });
    const pr = prOnBranch(id);
    await tick();
    expect(item(id).stage).toBe("building");
    expect(item(id).pr).toBeNull();
    // Back in building, the resumed builder ends its turn: the PR waits for the approval.
    await env.setStatus(builderOf(id).id, "idle");
    await tick();
    expect(item(id).stage).toBe("building");
    expect(item(id).note).toContain(EARLY);
    expect(waitingComments(pr.ref.number, issue)).toHaveLength(1);
  });

  it("closes the PR with a comment when the work stops without an approved spec", async () => {
    env = createFactoryEnv();
    enable();
    const { id, issue } = await feature();
    await submit(id);
    const pr = prOnBranch(id);
    await tick();
    expect(waitingComments(pr.ref.number, issue)).toHaveLength(1);

    // Asked for changes, the revised analysis decides not to build it: the item stops.
    await requestChanges(id);
    await env.factory.submitAnalysis(builderOf(id), {
      decision: "out_of_scope",
      summary: "Exports belong in the reporting add-on",
    });
    expect(item(id).stage).toBe("rejected");
    await tick();
    expect(env.gh.closed.map((c) => c.number)).toEqual([pr.ref.number]);
    expect(env.gh.closed[0]?.comment).toContain(`opened before the spec on #${issue} was approved`);
    expect(env.gh.prs.get(pr.ref.number)?.ref.state).toBe("closed");
    // Closed once: nothing is left to settle.
    await tick();
    expect(env.gh.closeAttempts).toBe(1);
  });
});
