import type { FactoryAnalysisReport, FactoryItem } from "@agent-rishi/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ServerToolContext } from "../src/mcp/define";
import { createPullRequestTool } from "../src/mcp/tools/github/create-pull-request";
import type { AppServices } from "../src/services/container";
import { builderResume } from "../src/services/factory/prompts";
import { createFactoryEnv, type FactoryEnv } from "./support/factory-env";

/**
 * Issue #365, follow-ups to the spec approval (#363): a builder restarted while it revises its
 * spec isn't told to open a pull request (and can't), and specs approved by turning approval off
 * say so on their issues. (The item page after a revision that decides not to build:
 * `apps/web/test/factory-spec-approval-card.test.tsx`.)
 */

let env: FactoryEnv;
afterEach(() => env?.close());

const enable = (specApproval = true) =>
  env.factory.setMode(env.project.id, {
    mode: "software_factory",
    limits: env.project.factoryLimits,
    tuning: { specApproval },
  });
const tick = () => env.factory.tick(env.project.id);
const item = (id: string) => env.factory.data.item(id) as FactoryItem;
const byIssue = (number: number) =>
  env.factory.data.items(env.project.id).find((i) => i.issue?.number === number) as FactoryItem;
const builderOf = (id: string) => env.repo.get(item(id).builderSessionId as string);
const toBuilder = (id: string) =>
  env.messages.filter((m) => m.sessionId === item(id).builderSessionId);

const SPEC: FactoryAnalysisReport = {
  decision: "implement",
  summary: "No export yet",
  spec: "An Export button that downloads the tasks as CSV",
  acceptanceCriteria: ["Export downloads a CSV of all tasks"],
};

async function feature(title = "Add CSV export"): Promise<{ id: string; issue: number }> {
  const issue = env.gh.openIssue({
    projectId: env.project.id,
    title,
    author: "agent-rishi",
    labels: ["enhancement"],
  });
  await tick();
  return { id: byIssue(issue.number).id, issue: issue.number };
}

async function submit(id: string, report: FactoryAnalysisReport = SPEC) {
  const res = await env.factory.submitAnalysis(builderOf(id), report);
  await env.setStatus(builderOf(id).id, "idle");
  return res;
}

/** The builder asks for changes and the loop sends them: the builder revises its spec. */
async function revising(id: string): Promise<void> {
  await env.factory.decideSpec(env.project.id, id, {
    decision: "request_changes",
    feedback: "Also offer JSON",
  });
  await tick();
  expect(toBuilder(id).at(-1)?.text).toMatch(/Revise the spec/);
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
  const call = () => createPullRequestTool.handler({ title: "Add CSV export" }, ctx);
  return { call, open };
}

describe("spec approval follow-ups (#365)", () => {
  it("tells a builder restarted mid-revision to finish its spec only, and refuses its pull request until the spec is approved", async () => {
    env = createFactoryEnv();
    enable();
    const { id } = await feature();
    const builder = builderOf(id).id;
    await submit(id);
    await revising(id);

    // The builder's session dies while it revises the spec; the loop puts it back.
    env.ranTurn(builder);
    await env.setStatus(builder, "failed");
    await tick();
    expect(item(id)).toMatchObject({ stage: "failed", failureKind: "infrastructure" });
    await tick();
    expect(item(id).stage).toBe("building");
    const cont = toBuilder(id).at(-1)?.text ?? "";
    expect(cont).toMatch(/\*\*Continue\*\*/);
    expect(cont).toContain("factory_submit_analysis");
    expect(cont).toContain("Also offer JSON");
    expect(cont).not.toContain("create_pull_request");
    // So does the "carry on" after a message raced its turn.
    expect(builderResume(item(id))).toContain("factory_submit_analysis");
    expect(builderResume(item(id))).not.toMatch(/pull request is open/);

    // Opening a pull request anyway is refused, while revising and while the revision waits.
    const pr = prTool(builder);
    await expect(pr.call()).rejects.toMatchObject({ code: "spec_not_approved" });
    await submit(id, { ...SPEC, spec: "Export as CSV or JSON" });
    expect(item(id).specApproval?.state).toBe("pending");
    await expect(pr.call()).rejects.toThrow(/spec/i);
    expect(pr.open).not.toHaveBeenCalled();

    // Approved, the builder implements it and opens its pull request as usual.
    await env.factory.decideSpec(env.project.id, id, { decision: "approve" });
    await tick();
    expect(toBuilder(id).at(-1)?.text).toMatch(/Implement feature/);
    await expect(pr.call()).resolves.toMatch(/Opened pull request #9/);
    expect(pr.open).toHaveBeenCalledTimes(1);
  });

  it("posts on each waiting spec's issue, once, when approval is turned off", async () => {
    env = createFactoryEnv();
    enable();
    const first = await feature();
    const second = await feature("Add JSON export");
    await submit(first.id);
    await submit(second.id);
    enable(false);
    await tick();
    await tick();
    const auto = (issue: number) =>
      env.gh.comments.filter(
        (c) =>
          c.number === issue &&
          c.body.includes("Spec approved automatically (spec approval turned off)"),
      );
    expect(item(first.id).specApproval).toMatchObject({ state: "approved", by: "auto" });
    expect(item(second.id).specApproval).toMatchObject({ state: "approved", by: "auto" });
    expect(auto(first.issue)).toHaveLength(1);
    expect(auto(second.issue)).toHaveLength(1);
  });
});
