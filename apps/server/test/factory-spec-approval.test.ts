import type { FactoryAnalysisReport, FactoryItem } from "@agent-rishi/contracts";
import { pipelineStep } from "@agent-rishi/contracts";
import { afterEach, describe, expect, it } from "vitest";
import { createFactoryEnv, type FactoryEnv } from "./support/factory-env";

/** Issue #363: with spec approval on, a person approves a feature's spec before it is built. */

let env: FactoryEnv;
afterEach(() => env?.close());

const enable = (limits: object = {}, specApproval = true, mode = "software_factory" as const) =>
  env.factory.setMode(env.project.id, {
    mode,
    limits: { ...env.project.factoryLimits, ...limits },
    tuning: { specApproval },
  });
const tick = () => env.factory.tick(env.project.id);
const item = (id: string) => env.factory.data.item(id) as FactoryItem;
const byIssue = (number: number) =>
  env.factory.data.items(env.project.id).find((i) => i.issue?.number === number) as FactoryItem;
const builderOf = (id: string) => env.repo.get(item(id).builderSessionId as string);
const inboxOf = (id: string) => env.inbox.find(`inbox:factory-spec:${id}`);
const toBuilder = (id: string) =>
  env.messages.filter((m) => m.sessionId === item(id).builderSessionId);

const SPEC: FactoryAnalysisReport = {
  decision: "implement",
  summary: "No export yet",
  spec: "An Export button that downloads the tasks as CSV",
  acceptanceCriteria: ["Export downloads a CSV of all tasks"],
};

/** A feature with a builder at work on it. */
async function feature(title = "Add CSV export"): Promise<string> {
  const issue = env.gh.openIssue({
    projectId: env.project.id,
    title,
    author: "agent-rishi",
    labels: ["enhancement"],
  });
  await tick();
  return byIssue(issue.number).id;
}

/** The builder submits its spec and ends its turn. */
async function submit(id: string, report: FactoryAnalysisReport = SPEC) {
  const res = await env.factory.submitAnalysis(builderOf(id), report);
  await env.setStatus(builderOf(id).id, "idle");
  return res;
}

describe("spec approval before building (#363)", () => {
  it("implements at once while approval is off (the default)", async () => {
    env = createFactoryEnv();
    enable({}, false);
    const id = await feature();
    const res = await submit(id);
    expect(res.next).toMatch(/Implement feature/);
    expect(item(id).specApproval).toBeNull();
    expect(inboxOf(id)).toBeUndefined();
    expect(env.gh.comments.at(-1)?.body).toMatch(/Next: Implement\./);
  });

  it("holds the spec for a person, then sends the Implement step once it is approved", async () => {
    env = createFactoryEnv();
    enable();
    const id = await feature();
    const builder = builderOf(id).id;
    const res = await submit(id);
    expect(res).toMatchObject({ recorded: true });
    expect(res.next).not.toMatch(/Implement feature/);
    expect(res.next).toMatch(/approves this spec before it is built/);
    expect(item(id).specApproval).toMatchObject({ state: "pending", rounds: 0, sentAt: null });
    expect(item(id).acceptanceCriteria).toEqual(SPEC.acceptanceCriteria);
    expect(pipelineStep(item(id))).toBe("analyze");
    expect(env.gh.comments.at(-1)?.body).toMatch(/approves the spec in Agent Rishi/);
    expect(inboxOf(id)).toMatchObject({
      status: "open",
      kind: "spec_approval",
      notify: "needs_you",
      sessionId: builder,
    });
    expect(inboxOf(id)?.body).toContain(SPEC.spec);
    // Submitting again changes nothing.
    expect((await env.factory.submitAnalysis(builderOf(id), SPEC)).recorded).toBe(false);

    // Idle far past the grace period: no reminder, no message, no failure.
    const before = env.messages.length;
    for (let i = 0; i < 3; i++) {
      env.clock.offsetMs += 30 * 60_000;
      await tick();
    }
    expect(env.messages.length).toBe(before);
    expect(item(id)).toMatchObject({
      stage: "building",
      note: "Waiting for you to approve the spec",
    });
    const status = await env.factory.status(env.project.id);
    expect(status.inProgress.find((w) => w.id === id)).toMatchObject({
      step: "analyze",
      specApproval: "pending",
    });
    const digest = await env.factory.digestNow(env.project.id);
    expect(digest.waiting.filter((w) => w.itemId === id || w.inboxItemId)).toEqual([
      expect.objectContaining({ itemId: id, title: "Add CSV export: Approve the spec" }),
    ]);

    env.clock.offsetMs = 0;
    const approved = await env.factory.decideSpec(env.project.id, id, { decision: "approve" });
    expect(approved.specApproval).toMatchObject({ state: "approved", by: "user", sentAt: null });
    expect(inboxOf(id)?.status).toBe("resolved");
    expect(env.gh.comments.at(-1)?.body).toMatch(/spec approved/);
    await tick();
    const sent = toBuilder(id);
    expect(sent).toHaveLength(1);
    expect(sent[0]?.text).toMatch(/Implement feature/);
    expect(sent[0]?.text).toContain(SPEC.spec);
    expect(item(id).specApproval?.sentAt).not.toBeNull();
    expect(pipelineStep(item(id))).toBe("implement");
    // Sent once; the builder carries on to its pull request as usual.
    await tick();
    expect(toBuilder(id)).toHaveLength(1);
    env.gh.openPr({ sessionId: builder, title: "Add CSV export", files: ["src/export.ts"] });
    await env.setStatus(builder, "idle");
    await tick();
    expect(item(id).stage).toBe("verifying");
    // A decision on a spec that no longer waits is refused.
    await expect(
      env.factory.decideSpec(env.project.id, id, { decision: "approve" }),
    ).rejects.toMatchObject({ code: "spec_not_pending" });
  });

  it("sends a request for changes to the builder, whose revised spec waits again", async () => {
    env = createFactoryEnv();
    enable();
    const id = await feature();
    await submit(id);
    await env.factory.decideSpec(env.project.id, id, {
      decision: "request_changes",
      feedback: "Also offer JSON",
    });
    expect(item(id).specApproval).toMatchObject({
      state: "changes_requested",
      feedback: "Also offer JSON",
      rounds: 1,
    });
    expect(inboxOf(id)?.status).toBe("resolved");
    expect(env.gh.comments.at(-1)?.body).toMatch(
      /changes requested to the spec[\s\S]*> Also offer JSON/,
    );
    expect(pipelineStep(item(id))).toBe("analyze");
    await tick();
    const sent = toBuilder(id);
    expect(sent).toHaveLength(1);
    expect(sent[0]?.text).toMatch(/Revise the spec/);
    expect(sent[0]?.text).toContain("Also offer JSON");
    expect(item(id).specApproval?.sentAt).not.toBeNull();

    const res = await env.factory.submitAnalysis(builderOf(id), {
      ...SPEC,
      spec: "Export as CSV or JSON",
      acceptanceCriteria: ["Export offers CSV and JSON"],
    });
    expect(res).toMatchObject({ recorded: true });
    expect(res.next).toMatch(/approves this spec/);
    expect(item(id).investigation?.details).toBe("Export as CSV or JSON");
    expect(item(id).acceptanceCriteria).toEqual(["Export offers CSV and JSON"]);
    expect(item(id).specApproval).toMatchObject({ state: "pending", rounds: 1, sentAt: null });
    expect(inboxOf(id)?.status).toBe("open");
    expect(env.gh.comments.at(-1)?.body).toMatch(/revised the analysis/);
  });

  it("releases a waiting spec when approval is turned off, and never holds one in a dark factory", async () => {
    env = createFactoryEnv();
    enable();
    const id = await feature();
    await submit(id);
    expect(item(id).specApproval?.state).toBe("pending");
    enable({}, false);
    await tick();
    expect(item(id).specApproval).toMatchObject({ state: "approved", by: "auto" });
    expect(toBuilder(id).at(-1)?.text).toMatch(/Implement feature/);
    expect(inboxOf(id)?.status).toBe("resolved");

    await env.close();
    env = createFactoryEnv();
    enable({}, true, "dark_factory" as "software_factory");
    const dark = await feature("Add JSON export");
    const res = await submit(dark);
    expect(res.next).toMatch(/Implement feature/);
    expect(item(dark).specApproval).toBeNull();
    expect(inboxOf(dark)).toBeUndefined();
  });

  it("keeps waiting specs out of the PRs-open limit and the drain", async () => {
    env = createFactoryEnv({ limits: { maxConcurrentSessions: 1 } });
    enable({ maxConcurrentSessions: 1 });
    const first = await feature();
    await submit(first);
    // The waiting spec takes no room: the next issue starts.
    const second = await feature("Add JSON export");
    expect(item(second).stage).toBe("building");
    // Approved, it waits for room under the limit (the second build will open a PR).
    await env.factory.decideSpec(env.project.id, first, { decision: "approve" });
    await tick();
    expect(toBuilder(first)).toHaveLength(0);
    expect(item(first).note).toMatch(/^Spec approved; waiting: finishing open work/);

    // The second's spec waits for a person too: a drain waits only for the approved first.
    await submit(second);
    const res = await env.factory.setKillSwitch(env.project.id, true, { mode: "drain" });
    expect(res).toMatchObject({ draining: true, inFlight: 1 });
  });

  it("clears the approval on a retry and resolves its inbox item", async () => {
    env = createFactoryEnv();
    enable();
    const id = await feature();
    await submit(id);
    env.factory.data.updateItem(id, (i) => ({
      ...i,
      stage: "failed",
      failureKind: "checks",
      reason: "Stopped by a test",
      finishedAt: new Date().toISOString(),
    }));
    env.factory.retry(env.project.id, id, "rebuild");
    expect(item(id)).toMatchObject({ stage: "backlog", investigation: null, specApproval: null });
    await tick();
    expect(inboxOf(id)?.status).toBe("resolved");
  });
});
