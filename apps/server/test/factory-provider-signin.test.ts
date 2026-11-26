import { type AgentEvent, agentEventToNewEvent, type InboxItem } from "@agent-rishi/contracts";
import { OpenCodeEventMapper } from "@agent-rishi/providers";
import { afterEach, describe, expect, it } from "vitest";
import { createFactoryEnv, type FactoryEnv } from "./support/factory-env";
import { factorySteps } from "./support/factory-steps";

// Issue #342: OpenCode's OpenAI login expired. A review on it failed with `Request failed: 401`
// (`auth`) and moved to another provider, but OpenCode was skipped for only 30 minutes (and not
// at all after a restart), so every half hour the next review failed on it again, adding another
// "Run failed" item each time. An expired login doesn't fix itself on a timer.

let env: FactoryEnv;
afterEach(() => env?.close());
const { item, tick, later, enable, backlogItem, openPr, review } = factorySteps(() => env);

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

/** Let the background provider detection a tick started finish. */
const settle = () => new Promise((r) => setImmediate(r));

/** Claude builds; reviews run on OpenCode, falling back to any other provider. */
function setup(): void {
  env = createFactoryEnv({ providers: ["claude", "codex", "opencode"] });
  enable("software_factory", {
    tuning: { builderProvider: "claude", reviewerProvider: "opencode", reviewerFallback: "any" },
  });
}

/** A feature built until its PR is under review. */
async function underReview(title: string, issue: number): Promise<string> {
  const created = backlogItem(title, issue);
  await tick();
  await openPr(created.id);
  await tick();
  expect(item(created.id).stage).toBe("verifying");
  return created.id;
}

/** The reviewer approves and ends its turn; the PR merges. */
async function approve(id: string): Promise<void> {
  const reviewer = item(id).reviewerSessionId as string;
  review(id);
  await env.setStatus(reviewer, "idle");
  await tick();
}

/** The OpenCode session's turn fails the way OpenCode reports it, through the real mapper. */
function openCodeTurnFails(sessionId: string, message = "Request failed: 401"): void {
  const events: AgentEvent[] = [];
  const mapper = new OpenCodeEventMapper({
    sessionId,
    emit: (e) => events.push(e),
    tools: { cwd: "/repo", mcpServers: [] },
  });
  mapper.rootSession = "ses_review";
  events.push({ type: "thread.started", thread: { id: mapper.rootThreadId } } as AgentEvent);
  mapper.beginTurn("turn-1");
  mapper.handle({ type: "session.execution.started", data: { sessionID: "ses_review" } });
  mapper.handle({
    type: "session.execution.failed",
    data: { sessionID: "ses_review", error: { type: "unknown", message } },
  });
  env.store.append(events.map((e) => agentEventToNewEvent(sessionId, e)));
}

/** The session's turn fails at the account's usage limit, which resets at `retryAt`. */
function turnHitsUsageLimit(sessionId: string, retryAt: string): void {
  const threadId = `t-${sessionId.slice(0, 8)}`;
  const events: AgentEvent[] = [
    { type: "thread.started", thread: { id: threadId } } as AgentEvent,
    { type: "turn.started", threadId, turnId: "u1" },
    {
      type: "turn.failed",
      threadId,
      turnId: "u1",
      error: { message: "Usage limit reached", kind: "usage_limit", retryAt },
    },
  ];
  env.store.append(events.map((e) => agentEventToNewEvent(sessionId, e)));
}

/** The session's root turn runs and completes. */
function turnCompletes(sessionId: string): void {
  const threadId = `t-${sessionId.slice(0, 8)}`;
  const events: AgentEvent[] = [
    { type: "thread.started", thread: { id: threadId } } as AgentEvent,
    { type: "turn.started", threadId, turnId: "u1" },
    { type: "turn.completed", threadId, turnId: "u1" },
  ];
  env.store.append(events.map((e) => agentEventToNewEvent(sessionId, e)));
}

/** A review on OpenCode fails because its login expired; the review moves elsewhere. */
async function reviewFailsOnOpenCode(id: string): Promise<string> {
  const failed = item(id).reviewerSessionId as string;
  expect(env.repo.get(failed).provider).toBe("opencode");
  openCodeTurnFails(failed);
  await tick();
  await tick();
  expect(item(id).reviewerProvider).not.toBe("opencode");
  return failed;
}

/** Move the clock and let a fresh detection run and finish. */
async function detectAfter(ms: number): Promise<void> {
  later(ms);
  await tick();
  await settle();
}

/** Every inbox item of the project, open or closed. */
function inboxItems(): InboxItem[] {
  const projectId = env.project.id;
  return [
    ...env.inbox.list({ projectId, status: "open" }),
    ...env.inbox.list({ projectId, status: "resolved" }),
    ...env.inbox.list({ projectId, status: "dismissed" }),
  ];
}

describe("a provider whose login expired (#342)", () => {
  it("stays skipped for factory work well past 30 minutes", async () => {
    setup();
    const first = await underReview("Add a counter", 3);
    await reviewFailsOnOpenCode(first);
    await approve(first);

    await detectAfter(3 * HOUR);
    expect(env.factory.providerRunnable("opencode")).toMatchObject({ runnable: false });
    const second = await underReview("Add a timer", 4);
    expect(item(second).reviewerProvider).not.toBe("opencode");
  });

  it("is chosen again once detection reports a changed login", async () => {
    setup();
    const first = await underReview("Add a counter", 3);
    await reviewFailsOnOpenCode(first);
    await approve(first);

    // The user signs in again: one detection sees OpenCode signed out, the next signed in.
    env.detected.opencode = { loggedIn: false };
    await detectAfter(6 * MINUTE);
    env.detected.opencode = {};
    await detectAfter(6 * MINUTE);
    expect(env.factory.providerRunnable("opencode")).toMatchObject({ runnable: true });
    const second = await underReview("Add a timer", 4);
    expect(item(second).reviewerProvider).toBe("opencode");
  });

  it("stays skipped after a restart", async () => {
    setup();
    const first = await underReview("Add a counter", 3);
    await reviewFailsOnOpenCode(first);
    await approve(first);

    env.restart();
    await tick();
    await settle();
    expect(env.factory.providerRunnable("opencode")).toMatchObject({ runnable: false });
    const second = await underReview("Add a timer", 4);
    expect(item(second).reviewerProvider).not.toBe("opencode");
  });

  it("leaves one inbox item however often it fails, which closes once the provider works", async () => {
    setup();
    const first = await underReview("Add a counter", 3);
    const failedFirst = await reviewFailsOnOpenCode(first);
    await approve(first);
    // Over half an hour later, OpenCode is tried again (its login looked different) and fails
    // the same way.
    env.detected.opencode = { loggedIn: false };
    await detectAfter(16 * MINUTE);
    env.detected.opencode = {};
    await detectAfter(16 * MINUTE);
    const second = await underReview("Add a timer", 4);
    const failedSecond = await reviewFailsOnOpenCode(second);

    const about = (sessionIds: string[]) =>
      inboxItems().filter(
        (i) =>
          (i.sessionId && sessionIds.includes(i.sessionId)) || /OpenCode|opencode/.test(i.title),
      );
    const items = about([failedFirst, failedSecond]);
    expect(items.filter((i) => i.kind === "run_failed")).toEqual([]);
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      status: "open",
      notify: "needs_you",
      title: expect.stringMatching(/^OpenCode isn't signed in.*: run `opencode auth login`$/),
      body: expect.stringMatching(/Request failed: 401/),
      attempts: 2,
    });
    await approve(second);

    // The user signs in again; the next review on OpenCode works, and the item closes.
    env.detected.opencode = { loggedIn: false };
    await detectAfter(6 * MINUTE);
    env.detected.opencode = {};
    await detectAfter(6 * MINUTE);
    const third = await underReview("Add a clock", 5);
    expect(item(third).reviewerProvider).toBe("opencode");
    turnCompletes(item(third).reviewerSessionId as string);
    await tick();
    expect(env.inbox.get(items[0]?.id as string).status).toBe("resolved");
  });

  it("at its usage limit is still skipped until the limit resets", async () => {
    setup();
    const first = await underReview("Add a counter", 3);
    const failed = item(first).reviewerSessionId as string;
    turnHitsUsageLimit(failed, new Date(env.now().getTime() + 2 * HOUR).toISOString());
    await tick();
    await tick();
    expect(item(first).reviewerProvider).not.toBe("opencode");
    await approve(first);

    await detectAfter(HOUR);
    expect(env.factory.providerRunnable("opencode")).toMatchObject({ runnable: false });
    await detectAfter(90 * MINUTE);
    expect(env.factory.providerRunnable("opencode")).toMatchObject({ runnable: true });
    const second = await underReview("Add a timer", 4);
    expect(item(second).reviewerProvider).toBe("opencode");
  });
});
