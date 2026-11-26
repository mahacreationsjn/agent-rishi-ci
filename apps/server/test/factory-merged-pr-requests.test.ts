import type { FactoryItem, ReviewVerdictInit } from "@agent-rishi/contracts";
import { ReviewVerdict } from "@agent-rishi/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ServerToolContext } from "../src/mcp/define";
import { createPullRequestTool } from "../src/mcp/tools/github/create-pull-request";
import type { AppServices } from "../src/services/container";
import { handleFailure } from "../src/services/factory/failures";
import { advanceConflicting } from "../src/services/factory/rebase";
import { createFactoryEnv, type FactoryEnv } from "./support/factory-env";
import type { FakePr } from "./support/fake-factory-github";

/**
 * Issue #507: a builder got requests to rebase its PR after the PR merged (one had waited in its
 * queue behind a running turn), rebased the merged branch, and `create_pull_request` opened a
 * duplicate PR. Requests go out only while the PR is open, queued ones are withdrawn when it
 * merges or closes, and a merged PR's agent can't open another one.
 */

const APPROVE: ReviewVerdictInit = {
  verdict: "approve",
  summary: "Meets the criteria",
  criteria: [{ criterion: "Counter increments", met: true }],
  vision: { aligned: true },
  tests: { adequate: true },
  security: { concerns: [] },
};

let env: FactoryEnv;
afterEach(() => env?.close());

const enable = () =>
  env.factory.setMode(env.project.id, {
    mode: "software_factory",
    limits: { ...env.project.factoryLimits, autoMerge: true },
  } as Parameters<FactoryEnv["factory"]["setMode"]>[1]);
const tick = () => env.factory.tick(env.project.id);
const item = (id: string) => env.factory.data.item(id) as FactoryItem;
const toBuilder = (builder: string) => env.messages.filter((m) => m.sessionId === builder);
const queuedFor = (builder: string) =>
  env.queued.filter((m) => m.sessionId === builder).map((m) => m.text);
const mergedOnGitHub = (pr: FakePr) => {
  pr.ref = { ...pr.ref, state: "merged" };
};

function review(id: string) {
  const session = env.repo.get(item(id).reviewerSessionId as string);
  return env.factory.submitReview(session, ReviewVerdict.parse(APPROVE));
}

/** The factory's context and loop, for a step run on a read of the PR that went stale. */
function step() {
  const ctx = env.factory.ctx;
  const project = ctx.projects.get(env.project.id);
  return { ctx, project, loop: ctx.store.loopOrNew(project.id, ctx.now()) };
}

/** A feature built until its PR is in verification; its builder is between turns. */
async function verifying() {
  const created = env.factory.data.createItem({
    projectId: env.project.id,
    workKey: "issue:3",
    title: "Add a counter",
    summary: "Users want to count things",
    source: "discovery",
    stage: "backlog",
    type: "feature",
    investigation: {
      kind: "analysis",
      outcome: "implement",
      summary: "Missing",
      details: "A counter",
      testPath: null,
      at: new Date().toISOString(),
    },
    score: 0.5,
    acceptanceCriteria: ["Counter increments"],
    issue: { number: 3, url: "https://github.com/acme/app/issues/3", title: "Add a counter" },
  });
  await tick();
  const builder = item(created.id).builderSessionId as string;
  const pr = env.gh.openPr({
    sessionId: builder,
    title: created.title,
    files: ["src/counter.ts", "test/counter.test.ts"],
  });
  await env.setStatus(builder, "idle");
  await tick();
  expect(item(created.id).stage).toBe("verifying");
  return { id: created.id, pr, builder };
}

/** `create_pull_request` as the builder calls it, with GitHub scripted. */
function prTool(sessionId: string) {
  const open = vi.fn(async () => ({
    number: 9,
    url: "https://github.com/acme/app/pull/9",
    state: "open" as const,
    created: true,
    branch: "agent-rishi/x",
    base: "main",
    commit: null,
  }));
  const services = { factory: env.factory, github: { createPullRequest: open } };
  const ctx = {
    services: services as unknown as AppServices,
    sessionId,
    projectId: env.project.id,
    role: "agent",
    caller: "mcp",
    signal: new AbortController().signal,
  } as ServerToolContext<"session">;
  const call = () => createPullRequestTool.handler({ title: "Add a counter" }, ctx);
  return { call, open };
}

describe("queued requests when the PR merges (#507)", () => {
  it("withdraws a rebase request waiting behind the builder's turn once a person merges the PR", async () => {
    env = createFactoryEnv();
    enable();
    env.queueWhenBusy = true;
    const { id, pr, builder } = await verifying();
    const before = toBuilder(builder).length;
    // The builder is mid-turn when the PR starts to conflict: the request waits for that turn.
    await env.setStatus(builder, "running");
    pr.mergeable = "conflicting";
    await tick();
    expect(item(id).nudges.rebase_1).toBeDefined();
    expect(queuedFor(builder)).toEqual([expect.stringMatching(/\*\*Rebase\*\*/)]);

    // A person merges it on GitHub before that turn ends.
    mergedOnGitHub(pr);
    await tick();
    expect(item(id).stage).toBe("merged");
    expect(queuedFor(builder)).toEqual([]);
    // The turn ends: nothing reaches the builder after the merge.
    await env.setStatus(builder, "idle");
    expect(toBuilder(builder)).toHaveLength(before);
    expect(env.repo.get(builder).status).toBe("idle");
  });

  it("withdraws it when the factory merges the PR itself", async () => {
    env = createFactoryEnv();
    enable();
    env.queueWhenBusy = true;
    const { id, pr, builder } = await verifying();
    const before = toBuilder(builder).length;
    await env.setStatus(builder, "running");
    pr.mergeable = "conflicting";
    await tick();
    expect(queuedFor(builder)).toHaveLength(1);

    // The conflict goes away by itself; CI passes, the review approves, and the queue merges it.
    Object.assign(pr, { mergeable: "mergeable", checks: "success" });
    await tick();
    review(id);
    await tick();
    expect(item(id).stage).toBe("watching");
    expect(env.gh.merges.map((m) => m.number)).toEqual([pr.ref.number]);
    expect(queuedFor(builder)).toEqual([]);
    await env.setStatus(builder, "idle");
    expect(toBuilder(builder)).toHaveLength(before);
  });
});

describe("requests for a PR that merged or closed after the step read it (#507)", () => {
  it("sends no rebase request for a PR that merged meanwhile", async () => {
    env = createFactoryEnv();
    enable();
    const { id, pr, builder } = await verifying();
    const before = toBuilder(builder).length;
    pr.mergeable = "conflicting";
    // The step read the PR open and conflicting; then it merged on GitHub.
    const read = await env.gh.prDetails(env.project.id, pr.ref.number);
    mergedOnGitHub(pr);
    const { ctx, project, loop } = step();
    await advanceConflicting(ctx, project, loop, item(id), read);
    expect(toBuilder(builder)).toHaveLength(before);
    expect(item(id).nudges.rebase_1).toBeUndefined();
    expect(item(id).stage).toBe("merged");
  });

  it("starts no revise round for a PR that was closed meanwhile", async () => {
    env = createFactoryEnv();
    enable();
    const { id, pr, builder } = await verifying();
    const before = toBuilder(builder).length;
    // The step recorded failed CI on the PR; then a person closed it.
    const failed = env.factory.data.updateItem(id, (i) => ({
      ...i,
      checks: [
        {
          name: "ci",
          state: "fail",
          detail: "CI failed: test",
          escalate: false,
          at: new Date().toISOString(),
        },
      ],
    }));
    pr.ref = { ...pr.ref, state: "closed" };
    const { ctx, project, loop } = step();
    await handleFailure(ctx, project, loop, failed);
    expect(toBuilder(builder)).toHaveLength(before);
    expect(item(id)).toMatchObject({ stage: "rejected", attempts: 0 });
  });
});

describe("create_pull_request after the PR merged (#507)", () => {
  it("is refused for the agent of an item whose PR merged, and opens no pull request", async () => {
    env = createFactoryEnv();
    enable();
    const { id, pr, builder } = await verifying();
    // While the PR is open, the call goes through (it updates that PR).
    const open = prTool(builder);
    await expect(open.call()).resolves.toMatch(/pull request #9/);
    expect(open.open).toHaveBeenCalledTimes(1);

    // Merged on GitHub: refused before the factory has even recorded it, and after.
    mergedOnGitHub(pr);
    const late = prTool(builder);
    await expect(late.call()).rejects.toMatchObject({ code: "pr_merged" });
    await tick();
    expect(item(id).stage).toBe("merged");
    await expect(late.call()).rejects.toThrow(`#${pr.ref.number} already merged`);
    expect(late.open).not.toHaveBeenCalled();
  });

  it("still lets work sent back to its builder after a revert open its new pull request", async () => {
    env = createFactoryEnv();
    enable();
    const { id, pr, builder } = await verifying();
    mergedOnGitHub(pr);
    env.factory.data.updateItem(id, (i) => ({
      ...i,
      stage: "building",
      pr: i.pr ? { ...i.pr, state: "merged" } : null,
      nudges: { ...i.nudges, after_revert: new Date().toISOString() },
    }));
    const again = prTool(builder);
    await expect(again.call()).resolves.toMatch(/Opened pull request #9/);
  });
});
