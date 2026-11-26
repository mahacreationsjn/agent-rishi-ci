import {
  type FactoryAnalysisReport,
  type FactoryItem,
  FactorySpecDecisionRequest,
  ReviewVerdict,
  type ReviewVerdictInit,
} from "@agent-rishi/contracts";
import { afterEach, describe, expect, it } from "vitest";
import { createFactoryEnv, type FactoryEnv } from "./support/factory-env";

/**
 * Issue #373, the spec approval (#363) against the work-in-progress limit and the kill switch:
 * approved specs waiting for room under the PRs-open limit never block each other, a spec that
 * waits for a person survives Stop now and a drain's time limit, and a decision made on a spec
 * that has changed since it was shown is refused.
 */

let env: FactoryEnv;
afterEach(() => env?.close());

const enable = (tuning: object = {}) =>
  env.factory.setMode(env.project.id, {
    mode: "software_factory",
    limits: { ...env.project.factoryLimits, autoMerge: true },
    tuning: { specApproval: true, ...tuning },
  });
const tick = () => env.factory.tick(env.project.id);
const item = (id: string) => env.factory.data.item(id) as FactoryItem;
const byIssue = (number: number) =>
  env.factory.data.items(env.project.id).find((i) => i.issue?.number === number) as FactoryItem;
const builderOf = (id: string) => env.repo.get(item(id).builderSessionId as string);
const inboxOf = (id: string) => env.inbox.find(`inbox:factory-spec:${id}`);
/** Messages to any builder this item has had, and the briefs of builders started for it. */
const toItem = (id: string) => {
  const workKey = item(id).workKey;
  const builders = new Set(env.repo.list({ workKey }).map((s) => s.id));
  return [
    ...env.starts.filter((s) => s.workKey === workKey).map((s) => JSON.stringify(s.input)),
    ...env.messages.filter((m) => builders.has(m.sessionId)).map((m) => m.text),
  ];
};
const implementSent = (id: string) => toItem(id).some((t) => /Implement feature/.test(t));

const SPEC: FactoryAnalysisReport = {
  decision: "implement",
  summary: "No export yet",
  spec: "An Export button that downloads the tasks as CSV",
  acceptanceCriteria: ["Export downloads a CSV of all tasks"],
};

const APPROVE: ReviewVerdictInit = {
  verdict: "approve",
  summary: "Meets the criteria",
  criteria: [{ criterion: "Export downloads a CSV of all tasks", met: true }],
  vision: { aligned: true },
  tests: { adequate: true },
  security: { concerns: [] },
};

/** A feature with a builder at work on it. */
async function feature(title: string): Promise<string> {
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

/** A building item's PR opens, is reviewed and approved, and merges. */
async function toMerged(id: string): Promise<void> {
  const builder = builderOf(id).id;
  const pr = env.gh.openPr({
    sessionId: builder,
    title: item(id).title,
    files: [`src/${id}.ts`, `test/${id}.test.ts`],
  });
  await env.setStatus(builder, "idle");
  await tick();
  expect(item(id).stage).toBe("verifying");
  const reviewer = env.repo.get(item(id).reviewerSessionId as string);
  env.factory.submitReview(reviewer, ReviewVerdict.parse(APPROVE));
  await env.setStatus(reviewer.id, "idle");
  env.gh.commitState.set(`merge${pr.ref.number}`, "success");
  for (let i = 0; i < 4 && item(id).stage !== "merged"; i++) await tick();
  expect(item(id).stage).toBe("merged");
}

describe("spec approval under the PRs-open limit and the kill switch (#373)", () => {
  it("sends approved specs oldest-first as room frees up, never deadlocking at a limit of 1", async () => {
    env = createFactoryEnv({ limits: { maxConcurrentSessions: 3 } });
    await enable({ maxOpenPrs: 1 });
    const first = await feature("Add CSV export");
    await submit(first);
    // The waiting spec takes no room: the next issue starts and reaches its spec too.
    const second = await feature("Add JSON export");
    expect(item(second).stage).toBe("building");
    await submit(second);
    await env.factory.decideSpec(env.project.id, first, { decision: "approve" });
    await env.factory.decideSpec(env.project.id, second, { decision: "approve" });

    // Room for one: the older approval is sent, the other waits its turn.
    for (let i = 0; i < 3; i++) await tick();
    expect(implementSent(first)).toBe(true);
    expect(implementSent(second)).toBe(false);

    // Once the first's PR merges, the second is sent.
    await toMerged(first);
    for (let i = 0; i < 2 && !implementSent(second); i++) await tick();
    expect(implementSent(second)).toBe(true);
  });

  it("keeps a waiting spec pending through Stop now: its inbox item stays open and nobody is told to implement it", async () => {
    env = createFactoryEnv();
    await enable();
    const id = await feature("Add CSV export");
    await submit(id);
    expect(inboxOf(id)?.status).toBe("open");

    await env.factory.setKillSwitch(env.project.id, true, { mode: "now" });
    expect(item(id).specApproval?.state).toBe("pending");
    await env.factory.setKillSwitch(env.project.id, false);
    for (let i = 0; i < 3; i++) await tick();

    expect(item(id).specApproval?.state).toBe("pending");
    expect(inboxOf(id)?.status).toBe("open");
    expect(implementSent(id)).toBe(false);

    // Approved, the work is implemented.
    await env.factory.decideSpec(env.project.id, id, { decision: "approve" });
    for (let i = 0; i < 2 && !implementSent(id); i++) await tick();
    expect(implementSent(id)).toBe(true);
  });

  it("keeps a waiting spec pending when a drain's time limit stops everything, also after a restart", async () => {
    env = createFactoryEnv({ limits: { maxConcurrentSessions: 3 } });
    await enable();
    const id = await feature("Add CSV export");
    await submit(id);
    // Other work is in flight, so the drain waits for it and runs out of time.
    const other = await feature("Add a dark theme");
    expect(item(other).stage).toBe("building");
    expect(
      await env.factory.setKillSwitch(env.project.id, true, { mode: "drain", drainLimitMin: 30 }),
    ).toMatchObject({ draining: true, inFlight: 1 });
    env.clock.offsetMs = 31 * 60_000;
    await tick();
    expect(env.factory.data.loopOrNew(env.project.id).state).toBe("stopped");
    expect(item(id).specApproval?.state).toBe("pending");

    env.restart();
    await env.factory.setKillSwitch(env.project.id, false);
    for (let i = 0; i < 3; i++) await tick();
    expect(item(id).specApproval?.state).toBe("pending");
    expect(inboxOf(id)?.status).toBe("open");
    expect(implementSent(id)).toBe(false);
  });

  it("refuses a decision on a spec that changed since it was shown (409)", async () => {
    env = createFactoryEnv();
    await enable();
    const id = await feature("Add CSV export");
    await submit(id);
    // A tab shows the first version.
    const shown = item(id).specApproval?.requestedAt as string;

    // Meanwhile changes are requested elsewhere and the builder submits a revised spec.
    await env.factory.decideSpec(env.project.id, id, {
      decision: "request_changes",
      feedback: "Also offer JSON",
    });
    await tick();
    env.clock.offsetMs += 1_000;
    await submit(id, { ...SPEC, spec: "Export as CSV or JSON" });
    const current = item(id).specApproval?.requestedAt as string;
    expect(current).not.toBe(shown);

    // The stale tab's decisions are refused, and the revised spec still waits.
    for (const req of [
      { decision: "approve", version: shown },
      { decision: "request_changes", feedback: "Shorter", version: shown },
    ]) {
      await expect(
        env.factory.decideSpec(env.project.id, id, FactorySpecDecisionRequest.parse(req)),
      ).rejects.toMatchObject({ status: 409 });
    }
    expect(item(id).specApproval).toMatchObject({ state: "pending", requestedAt: current });

    // The inbox card decides on the version it shows (its item's `updatedAt`), which goes through.
    const card = inboxOf(id);
    expect(card).toMatchObject({ status: "open", updatedAt: current });
    expect(card?.body).toContain("Export as CSV or JSON");
    const approved = await env.factory.decideSpec(
      env.project.id,
      id,
      FactorySpecDecisionRequest.parse({ decision: "approve", version: card?.updatedAt }),
    );
    expect(approved.specApproval?.state).toBe("approved");
  });
});
