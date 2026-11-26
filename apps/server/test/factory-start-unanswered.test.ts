import {
  type AgentEvent,
  agentEventToNewEvent,
  ReviewVerdict,
  type RunnerCommand,
} from "@agent-rishi/contracts";
import { afterEach, describe, expect, it } from "vitest";
import { RunnerCommandError } from "../src/runner/client";
import { START_ANSWER_GRACE_MS } from "../src/services/factory/late-start";
import type { RunnerPort } from "../src/services/runner-port";
import { type LauncherDeps, SessionLauncher } from "../src/services/sessions/launcher";
import { createFactoryEnv, type FactoryEnv } from "./support/factory-env";
import { APPROVE, factorySteps } from "./support/factory-steps";

// Issue #492: under load, a reviewer's `session.start` timed out on the runner. The factory
// counted it as a provider failure (a 30-minute skip of the provider) and let the reviewer go,
// though the session had started: it approved the PR, and its verdict was refused.

let env: FactoryEnv;
afterEach(() => env?.close());
const { item, tick, later, enable, verifying, backlogItem } = factorySteps(() => env);

/** A runner that is connected but too busy to answer any command in time. */
function busyRunner(code = "timeout"): RunnerPort {
  return {
    isConnected: () => true,
    waitForConnection: async () => true,
    runnerId: () => null,
    providers: () => [],
    mcpProxyUrl: () => null,
    request: async (command: RunnerCommand) => {
      throw new RunnerCommandError(code, `Runner command ${command.name} timed out`);
    },
  } as unknown as RunnerPort;
}

/** The session's start, through the real launcher, against a runner that doesn't answer it. */
async function startGoesUnanswered(sessionId: string, runner = busyRunner()) {
  const launcher = new SessionLauncher({
    repo: env.repo,
    inbox: env.inbox,
    projects: { get: () => env.project },
    runner,
    worktreesDir: `${env.dir}/wt`,
  } as unknown as LauncherDeps);
  await launcher.launch(sessionId, { workspace: { mode: "worktree" } });
  expect(env.repo.get(sessionId).status).toBe("failed");
}

/** The runner opened the session after all: its first turn's events arrive. */
function startsAnyway(sessionId: string) {
  const thread = `t-${sessionId}`;
  const events: AgentEvent[] = [
    { type: "thread.started", thread: { id: thread } } as AgentEvent,
    { type: "turn.started", threadId: thread, turnId: `u-${sessionId}` } as AgentEvent,
  ];
  env.store.append(events.map((e) => agentEventToNewEvent(sessionId, e)));
  expect(env.repo.get(sessionId).status).toBe("running");
}

/** Its verdict, as its `factory_submit_review` call sends it (a refusal rejects). */
const submits = async (sessionId: string) => {
  await env.factory.submitReview(env.repo.get(sessionId), ReviewVerdict.parse(APPROVE));
};

const reviewStarts = () => env.starts.filter((s) => s.workKey?.startsWith("factory:review:"));

/** Nudges that would mean the start counted against the provider or the reviewer. */
const failureMarks = (id: string) =>
  Object.keys(item(id).nudges).filter((k) => /^reviewer_(skip_|provider_failed_|failed_)/.test(k));

/** A PR in verification whose reviewer's start went unanswered, and the tick after it. */
async function reviewerUnanswered() {
  env = createFactoryEnv();
  await enable();
  const { id } = await verifying("pending");
  const reviewer = item(id).reviewerSessionId as string;
  const provider = item(id).reviewerProvider as string;
  await startGoesUnanswered(reviewer);
  await tick();
  return { id, reviewer, provider };
}

describe("a factory session whose start the runner didn't answer (#492)", () => {
  it("is no provider failure: the reviewer is waited for, and its verdict counts once it started", async () => {
    const { id, reviewer, provider } = await reviewerUnanswered();
    expect(item(id)).toMatchObject({
      reviewerSessionId: reviewer,
      note: expect.stringMatching(/too busy to answer the reviewer's start: waiting until/),
    });
    expect(failureMarks(id)).toEqual([]);
    expect(env.factory.providerRunnable(provider).runnable).toBe(true);

    startsAnyway(reviewer);
    await tick();
    expect(item(id).reviewerSessionId).toBe(reviewer);
    await submits(reviewer);
    expect(item(id).review?.verdict).toBe("approve");
    await tick();
    expect(item(id).checks.find((c) => c.name === "review")?.state).toBe("pass");
    expect(reviewStarts()).toHaveLength(1);
  });

  it("starts a fresh reviewer on the same provider once the wait is over", async () => {
    const { id, reviewer, provider } = await reviewerUnanswered();
    later(START_ANSWER_GRACE_MS + 1_000);
    await tick();
    await tick();
    const fresh = item(id).reviewerSessionId as string;
    expect(fresh).toBeTruthy();
    expect(fresh).not.toBe(reviewer);
    // Replaced like a reviewer that died: no skip of the provider, no back-off.
    expect(env.repo.get(fresh).provider).toBe(provider);
    expect(failureMarks(id)).toEqual(["reviewer_failed_1"]);
    expect(env.factory.providerRunnable(provider).runnable).toBe(true);
  });

  it("adopts a reviewer that starts after the wait while no fresh one has started", async () => {
    const { id, reviewer } = await reviewerUnanswered();
    later(START_ANSWER_GRACE_MS + 1_000);
    await tick();
    expect(item(id).reviewerSessionId).toBeNull();

    startsAnyway(reviewer);
    await tick();
    expect(item(id)).toMatchObject({
      reviewerSessionId: reviewer,
      note: expect.stringMatching(/^The reviewer started after all/),
    });
    expect(item(id).earlierSessionIds).not.toContain(reviewer);
    await submits(reviewer);
    expect(item(id).review?.verdict).toBe("approve");
    expect(reviewStarts()).toHaveLength(1);
    expect(env.stopped).not.toContain(reviewer);
  });

  it("stops and archives a reviewer that starts after a fresh one took its place", async () => {
    const { id, reviewer } = await reviewerUnanswered();
    later(START_ANSWER_GRACE_MS + 1_000);
    await tick();
    await tick();
    const fresh = item(id).reviewerSessionId as string;
    expect(fresh).not.toBe(reviewer);

    startsAnyway(reviewer);
    await tick();
    await env.factory.archiver.idle();
    expect(env.stopped).toContain(reviewer);
    expect(env.archived).toContain(reviewer);
    expect(item(id).reviewerSessionId).toBe(fresh);
    // Only the current reviewer's verdict counts.
    await expect(submits(reviewer)).rejects.toThrow(/not reviewing a factory pull request/);
    await submits(fresh);
    expect(item(id).review?.verdict).toBe("approve");
  });

  it("still skips the provider for the item when the runner refused the start", async () => {
    env = createFactoryEnv();
    await enable();
    const { id } = await verifying("pending");
    const reviewer = item(id).reviewerSessionId as string;
    const provider = item(id).reviewerProvider as string;
    await startGoesUnanswered(reviewer, busyRunner("command_failed"));
    await tick();
    expect(item(id).reviewerSessionId).toBeNull();
    expect(item(id).nudges[`reviewer_skip_${provider}`]).toBeDefined();
  });

  it("waits for a builder whose start went unanswered, then fails it outside its code", async () => {
    env = createFactoryEnv();
    await enable();
    const { id } = backlogItem();
    await tick();
    const builder = item(id).builderSessionId as string;
    const provider = env.repo.get(builder).provider;
    await startGoesUnanswered(builder);
    await tick();
    expect(item(id)).toMatchObject({
      stage: "building",
      builderSessionId: builder,
      note: expect.stringMatching(/too busy to answer the builder's start/),
    });

    later(START_ANSWER_GRACE_MS + 1_000);
    await tick();
    expect(item(id)).toMatchObject({ stage: "failed", failureKind: "infrastructure" });
    expect(env.factory.providerRunnable(provider).runnable).toBe(true);
  });
});
