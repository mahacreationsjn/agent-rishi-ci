import { agentEventToNewEvent, type Session, type Usage } from "@agent-rishi/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ServiceError } from "../src/services/errors";
import { SCOUT_PLAN_NUDGE } from "../src/services/factory/prompts-scout";
import { compactBeforeRound, ROUND_COMPACT_TOKENS } from "../src/services/factory/scout-compact";
import { createFactoryEnv, type FactoryEnv } from "./support/factory-env";

let env: FactoryEnv;
afterEach(() => env?.close());

const tick = () => env.factory.tick(env.project.id);
const loop = () => env.factory.data.loopOrNew(env.project.id);
const session = (id: string | null | undefined) => env.repo.get(id as string);

/** The context size a session's provider last reported (a report without a turn). */
function reportContext(sessionId: string, usage: Usage) {
  env.store.append([
    agentEventToNewEvent(sessionId, { type: "usage.updated", threadId: "t-root", usage }),
  ]);
}

/** What happened to sessions, in order: compactions and messages. */
let log: string[];
/** Sessions with a message waiting behind a compaction (the scripted outbox). */
let pending: Set<string>;

/**
 * A dark factory whose session service compacts on demand: a compaction marks the session
 * running and is logged, and messages are logged as they are sent.
 */
function darkFactory() {
  env = createFactoryEnv({ limits: { maxConcurrentSessions: 3 } });
  env.factory.setMode(env.project.id, {
    mode: "dark_factory",
    limits: { ...env.project.factoryLimits, maxConcurrentSessions: 3 },
    tuning: { discoveryPerRound: 1, maxIssuesPerRound: 1 },
  });
  log = [];
  pending = new Set();
  const sessions = env.sessions as unknown as Record<string, unknown>;
  const send = env.sessions.send.bind(env.sessions);
  sessions.send = async (...args: Parameters<typeof send>) => {
    log.push(`message:${args[0]}`);
    return send(...args);
  };
  sessions.compact = async (id: string) => {
    log.push(`compact:${id}`);
    env.repo.update(id, (s) => ({ ...s, status: "running" }));
    return { status: "compacting" };
  };
  sessions.hasOutbox = (id: string) => pending.has(id);
}

/** Run round 1 to its end: the scout plans one area reviewer, which reports nothing. */
async function firstRound(): Promise<{ scout: Session; lens: Session }> {
  await tick();
  const scout = session(loop().scout.sessionId);
  await env.factory.planRound(scout, { lenses: [{ area: "ux", focus: "forms" }] });
  await tick();
  const lens = session(loop().scout.lensSessions.ux);
  await env.factory.reportFindings(lens, []);
  await env.setStatus(lens.id, "idle");
  await tick();
  await env.setStatus(scout.id, "idle");
  await tick();
  expect(loop().scout.round).toBeNull();
  return { scout, lens };
}

/**
 * Start the next round with "Run scout now", on the process clock: moving the factory's clock
 * ahead instead would leave every session update behind the round's send time.
 */
async function nextRound() {
  log.length = 0;
  await env.factory.runScout(env.project.id);
  expect(loop().scout.round?.phase).toBe("planning");
}

describe("compactBeforeRound", () => {
  it("compacts from 60k tokens of context, or half the window when that is smaller", () => {
    expect(ROUND_COMPACT_TOKENS).toBe(60_000);
    expect(compactBeforeRound(null)).toBe(false);
    expect(compactBeforeRound({ contextWindow: 200_000 })).toBe(false);
    expect(compactBeforeRound({ contextTokens: 59_999 })).toBe(false);
    expect(compactBeforeRound({ contextTokens: 60_000 })).toBe(true);
    expect(compactBeforeRound({ contextTokens: 60_000, contextWindow: 1_000_000 })).toBe(true);
    expect(compactBeforeRound({ contextTokens: 32_000, contextWindow: 64_000 })).toBe(true);
    expect(compactBeforeRound({ contextTokens: 31_999, contextWindow: 64_000 })).toBe(false);
  });
});

describe("compaction between scout rounds (§10.1)", () => {
  it("compacts a reused scout and area reviewer whose context grew, then sends the brief", async () => {
    darkFactory();
    const { scout, lens } = await firstRound();
    // Round 1 started fresh sessions: nothing to compact then.
    reportContext(scout.id, { contextTokens: 140_000, contextWindow: 200_000 });
    reportContext(lens.id, { contextTokens: 75_000, contextWindow: 200_000 });

    await nextRound();
    expect(log).toEqual([`compact:${scout.id}`, `message:${scout.id}`]);
    expect(env.messages.at(-1)?.text).toMatch(/Round 2/);

    log.length = 0;
    await env.factory.planRound(session(scout.id), { lenses: [{ area: "ux", focus: "tables" }] });
    await tick();
    // The area reviewer is woken in the background.
    await vi.waitFor(() => expect(log).toEqual([`compact:${lens.id}`, `message:${lens.id}`]));
    expect(loop().scout.round?.lenses[0]?.sessionId).toBe(lens.id);
  });

  it("sends the brief at once when the context is small or not reported", async () => {
    darkFactory();
    const { scout, lens } = await firstRound();
    reportContext(scout.id, { contextTokens: 20_000, contextWindow: 200_000 });

    await nextRound();
    expect(log).toEqual([`message:${scout.id}`]);
    log.length = 0;
    await env.factory.planRound(session(scout.id), { lenses: [{ area: "ux", focus: "tables" }] });
    await tick();
    await vi.waitFor(() => expect(log).toEqual([`message:${lens.id}`]));
  });

  it("still sends the brief when the compaction is refused or fails", async () => {
    darkFactory();
    const { scout } = await firstRound();
    reportContext(scout.id, { contextTokens: 140_000 });
    const sessions = env.sessions as unknown as Record<string, unknown>;
    sessions.compact = async () => {
      log.push("refused");
      throw new ServiceError(409, "unsupported", "Cursor can't compact a conversation.");
    };
    await nextRound();
    expect(log).toEqual(["refused", `message:${scout.id}`]);
    expect(env.messages.at(-1)?.text).toMatch(/Round 2/);

    // A runner away: the round goes on the same way.
    await env.factory.planRound(session(scout.id), { lenses: [] });
    await env.setStatus(scout.id, "idle");
    await tick();
    expect(loop().scout.round).toBeNull();
    sessions.compact = async () => {
      log.push("failed");
      throw new ServiceError(503, "runner_unavailable", "The runner is not connected");
    };
    await nextRound();
    expect(log).toEqual(["failed", `message:${scout.id}`]);
  });

  it("doesn't take the compaction turn for the round's: no nudge or close while the brief waits", async () => {
    darkFactory();
    const { scout } = await firstRound();
    reportContext(scout.id, { contextTokens: 140_000 });
    await nextRound();
    const messages = env.messages.length;

    // The compaction ended (or failed) and the brief still waits in the queue.
    pending.add(scout.id);
    await env.setStatus(scout.id, "idle");
    await tick();
    await env.setStatus(scout.id, "failed");
    await tick();
    expect(loop().scout.round?.phase).toBe("planning");
    expect(env.messages).toHaveLength(messages);

    // Its turn ended without a plan once nothing waits: reminded as before.
    pending.delete(scout.id);
    await env.setStatus(scout.id, "idle");
    await tick();
    expect(env.messages.at(-1)).toMatchObject({ sessionId: scout.id, text: SCOUT_PLAN_NUDGE });
  });
});
