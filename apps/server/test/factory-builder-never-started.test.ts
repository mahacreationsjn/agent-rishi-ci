import { type AgentEvent, agentEventToNewEvent, type RunnerCommand } from "@agent-rishi/contracts";
import { afterEach, describe, expect, it } from "vitest";
import { RunnerCommandError } from "../src/runner/client";
import { START_ANSWER_GRACE_MS } from "../src/services/factory/late-start";
import type { RunnerPort } from "../src/services/runner-port";
import { type LauncherDeps, SessionLauncher } from "../src/services/sessions/launcher";
import { createFactoryEnv, type FactoryEnv } from "./support/factory-env";
import { factorySteps } from "./support/factory-steps";

// Issue #529: the builder's brief exists only as the first input of its `session.start`. When
// that start never reached the provider (the runner left it unanswered, or refused it), the item
// failed outside its code and the recovery resumed the builder with only "Continue … pick up
// where you left off", so the agent's first and only instruction had no brief at all.

let env: FactoryEnv;
afterEach(() => env?.close());
const { item, tick, later, enable, backlogItem, lastMessageTo } = factorySteps(() => env);

/** A runner that is connected but answers every command with `code`. */
function failingRunner(code: string): RunnerPort {
  return {
    isConnected: () => true,
    waitForConnection: async () => true,
    runnerId: () => null,
    providers: () => [],
    mcpProxyUrl: () => null,
    request: async (command: RunnerCommand) => {
      throw new RunnerCommandError(code, `Runner command ${command.name} failed (${code})`);
    },
  } as unknown as RunnerPort;
}

/** The session's start, through the real launcher, against a runner that fails it. */
async function startFails(sessionId: string, code: string) {
  const launcher = new SessionLauncher({
    repo: env.repo,
    inbox: env.inbox,
    projects: { get: () => env.project },
    runner: failingRunner(code),
    worktreesDir: `${env.dir}/wt`,
  } as unknown as LauncherDeps);
  await launcher.launch(sessionId, { workspace: { mode: "worktree" } });
  expect(env.repo.get(sessionId).status).toBe("failed");
  expect(env.repo.turnCount(sessionId)).toBe(0);
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

const builderStarts = () => env.starts.filter((s) => s.workKey === "issue:3");

/** A builder whose start failed (`code`), and the ticks until its item failed outside its code. */
async function builderNeverStarted(code: string) {
  env = createFactoryEnv();
  await enable();
  const { id } = backlogItem();
  await tick();
  const builder = item(id).builderSessionId as string;
  expect(builderStarts()).toHaveLength(1);
  await startFails(builder, code);
  // An unanswered start is waited for first (`late-start.ts`); a refused one isn't.
  later(START_ANSWER_GRACE_MS + 1_000);
  await tick();
  expect(item(id)).toMatchObject({ stage: "failed", failureKind: "infrastructure" });
  return { id, builder };
}

describe("a builder whose first start never reached its provider (#529)", () => {
  for (const [why, code] of [
    ["the runner left its start unanswered", "timeout"],
    ["the runner refused its start", "command_failed"],
  ] as const) {
    it(`counts as gone when ${why}: a fresh builder starts with the brief`, async () => {
      const { id, builder } = await builderNeverStarted(code);
      await tick();
      await tick();

      // Never told to "pick up where you left off": it has nothing to pick up.
      expect(env.messages.filter((m) => m.sessionId === builder)).toEqual([]);
      // A fresh builder gets the whole brief (the issue and its acceptance criteria).
      expect(builderStarts()).toHaveLength(2);
      const fresh = item(id).builderSessionId as string;
      expect(fresh).toBeTruthy();
      expect(fresh).not.toBe(builder);
      expect(builderStarts()[1]?.input?.text).toContain("Counter increments");
      expect(item(id)).toMatchObject({
        stage: "building",
        nudges: { infra_1: expect.any(String) },
      });
      // The old session is an earlier session of the item, archived by cleanup.
      await env.factory.archiver.idle();
      expect(env.archived).toContain(builder);
    });
  }

  it("starts the fresh builder on another provider when its own refused to open it (signed out)", async () => {
    env = createFactoryEnv();
    await enable();
    const { id } = backlogItem();
    await tick();
    const builder = item(id).builderSessionId as string;
    const provider = env.repo.get(builder).provider;
    env.repo.update(builder, (s) => ({
      ...s,
      status: "failed",
      startError: { code: "open_failed", message: "Not signed in", kind: "auth" },
    }));
    await tick();
    expect(item(id)).toMatchObject({ stage: "failed", failureKind: "infrastructure" });
    expect(env.factory.providerRunnable(provider).runnable).toBe(false);

    await tick();
    await tick();
    expect(env.messages.filter((m) => m.sessionId === builder)).toEqual([]);
    const fresh = item(id).builderSessionId as string;
    expect(fresh).not.toBe(builder);
    expect(env.repo.get(fresh).provider).not.toBe(provider);
    expect(builderStarts()[1]?.input?.text).toContain("Counter increments");
  });

  it("stops and archives the old builder when it opens late after a fresh one took the item", async () => {
    const { id, builder } = await builderNeverStarted("timeout");
    await tick();
    await tick();
    const fresh = item(id).builderSessionId as string;
    expect(fresh).not.toBe(builder);

    startsAnyway(builder);
    await tick();
    await env.factory.archiver.idle();
    expect(env.stopped).toContain(builder);
    expect(env.archived).toContain(builder);
    expect(item(id).builderSessionId).toBe(fresh);
    expect(env.messages.filter((m) => m.sessionId === builder)).toEqual([]);
  });

  it("still resumes a builder that ran a turn before it failed with a 'continue' message", async () => {
    env = createFactoryEnv();
    await enable();
    const { id } = backlogItem();
    await tick();
    const builder = item(id).builderSessionId as string;
    env.ranTurn(builder);
    await env.setStatus(builder, "failed");
    await tick();
    expect(item(id)).toMatchObject({ stage: "failed", failureKind: "infrastructure" });

    await tick();
    expect(item(id)).toMatchObject({ stage: "building", builderSessionId: builder });
    expect(lastMessageTo(builder)).toMatch(/^\*\*Continue\*\*/);
    expect(builderStarts()).toHaveLength(1);
  });
});
