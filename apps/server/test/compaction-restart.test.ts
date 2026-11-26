import type { AgentEvent, RunnerEvent, RunnerEventMessage, Session } from "@agent-rishi/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ingestRunnerEvent } from "../src/events/ingest";
import type { RunnerPort } from "../src/services/runner-port";
import type { SessionLauncher } from "../src/services/sessions/launcher";
import { SessionRecovery } from "../src/services/sessions/recovery";
import type { SessionService } from "../src/services/sessions/session-service";
import { createGithubEnv, type GithubEnv } from "./support/github-env";

/**
 * A compaction cut off by a runner restart (#460). "Compact now", or the factory's compaction
 * between scout rounds, is a turn of its own (`kind: "compact"`). When the runner crashes or
 * drains during it, recovery must not answer with "continue where you left off": the agent's
 * last task is finished, so continuing re-runs it (and the scout's round brief, queued behind
 * the compaction, then waits for that re-run).
 */

const T = "t-root";

let env: GithubEnv;
let seq = 0;

beforeEach(() => {
  env = createGithubEnv();
  seq = 0;
});
afterEach(async () => {
  await env.close();
});

/** Ingest runner events the way the server does (agent events and process lifecycle). */
const ingest = (...events: RunnerEvent[]) => {
  for (const event of events) {
    const msg: RunnerEventMessage = {
      type: "event",
      seq: ++seq,
      ts: new Date(Date.parse("2026-11-07T10:00:00.000Z") + seq * 1000).toISOString(),
      event,
    };
    ingestRunnerEvent(env.db.db, env.store, "r1", msg);
  }
};
const agent = (sessionId: string, ...events: AgentEvent[]) =>
  ingest(...events.map((event): RunnerEvent => ({ kind: "agent", sessionId, event })));

/** A finished work turn: the user's task, the agent's answer. */
const workTurn = (turnId: string): AgentEvent[] => [
  { type: "turn.started", threadId: T, turnId },
  {
    type: "item.completed",
    threadId: T,
    turnId,
    item: {
      id: `${turnId}-user`,
      kind: "user_message",
      status: "completed",
      input: { text: "Add the login page", attachments: [] },
    },
  },
  {
    type: "item.completed",
    threadId: T,
    turnId,
    item: { id: `${turnId}-reply`, kind: "assistant_message", status: "completed", text: "Done" },
  },
  { type: "turn.completed", threadId: T, turnId, stopReason: "end_turn" },
];

/** A compaction that has started and not ended (`SessionHost.compact` marks its turn). */
const compactionStarted = (turnId: string): AgentEvent[] => [
  { type: "turn.started", threadId: T, turnId, kind: "compact" },
  {
    type: "item.completed",
    threadId: T,
    turnId,
    item: {
      id: `${turnId}-notice`,
      kind: "notice",
      status: "completed",
      level: "info",
      code: "compacting",
      message: "Compacting the conversation to free up context…",
    },
  },
];

/** A session that finished a task and then started compacting: `running`, mid-compaction. */
const compactingSession = (): Session => {
  const s = env.addSession({ status: "running", provider: "fake", resumeToken: "resume-1" });
  agent(s.id, { type: "thread.started", thread: { id: T } });
  agent(s.id, ...workTurn("u1"));
  agent(s.id, ...compactionStarted("c1"));
  expect(env.repo.get(s.id).status).toBe("running");
  return s;
};

/** A session cut off in the middle of a work turn. */
const workingSession = (): Session => {
  const s = env.addSession({ status: "running", provider: "fake", resumeToken: "resume-1" });
  agent(s.id, { type: "thread.started", thread: { id: T } });
  agent(s.id, { type: "turn.started", threadId: T, turnId: "u1" });
  return s;
};

/** Recovery with the real repo; the runner hosts nothing (it restarted), sends are recorded. */
function recovery() {
  const continued: Array<[string, string]> = [];
  const flushed: string[] = [];
  const queued = new Set<string>();
  const sessions = {
    launching: new Map<string, Promise<void>>(),
    isDelivering: () => false,
    continueAfterRestart: vi.fn(async (id: string, text: string) => {
      continued.push([id, text]);
    }),
    releaseOutboxes: () => undefined,
    sessionsWithQueuedMessages: () => [...queued],
    flushOutbox: vi.fn(async (id: string) => {
      flushed.push(id);
    }),
  } as unknown as SessionService;
  const fail = vi.fn();
  const runner = {
    request: async () => ({
      sessions: [],
      ptys: [],
      journal: { lastSeq: 0, unacked: 0 },
      draining: false,
    }),
    providers: () => [{ id: "fake", capabilities: { resume: true, compact: true } }],
  } as unknown as RunnerPort;
  const r = new SessionRecovery({
    repo: env.repo,
    sessions,
    launcher: { fail } as unknown as SessionLauncher,
    runner,
  });
  return { recovery: r, continued, flushed, queued, fail };
}

describe("a compaction cut off by a runner restart", () => {
  it("after a runner crash, is not continued with 'continue where you left off'", async () => {
    const s = compactingSession();
    const t = recovery();

    await t.recovery.onRunnerReady();

    // "Continue where you left off" would re-run the finished task ("Add the login page").
    expect(t.continued).toEqual([]);
    expect(t.fail).not.toHaveBeenCalled();
    // The compaction is closed as cut off, and the session waits for its next message.
    expect(env.repo.turn(s.id, "c1")).toMatchObject({ kind: "compact", status: "interrupted" });
    expect(env.repo.get(s.id).status).toBe("idle");
  });

  it("after a runner drain, is not continued with 'continue where you left off'", async () => {
    const s = compactingSession();
    // The draining runner interrupts the compaction and closes the provider process.
    agent(s.id, { type: "turn.interrupted", threadId: T, turnId: "c1", reason: "runner_restart" });
    ingest({
      kind: "session.process",
      sessionId: s.id,
      state: "exited",
      reason: "runner_exit",
      interruptedTurn: true,
    });
    const t = recovery();

    await t.recovery.onRunnerReady();

    expect(t.continued).toEqual([]);
    expect(t.fail).not.toHaveBeenCalled();
    expect(env.repo.turn(s.id, "c1")).toMatchObject({ kind: "compact", status: "interrupted" });
    expect(env.repo.get(s.id).status).toBe("idle");
  });

  it("delivers the round's brief queued behind the compaction, and nothing before it", async () => {
    const s = compactingSession();
    const t = recovery();
    // The factory compacted the scout before its round: the brief waits in the session's queue.
    t.queued.add(s.id);

    await t.recovery.onRunnerReady();

    expect(t.continued).toEqual([]);
    expect(t.flushed).toEqual([s.id]);
  });

  it("a work turn cut off by a restart is still continued", async () => {
    const s = workingSession();
    const t = recovery();

    await t.recovery.onRunnerReady();

    expect(t.continued).toEqual([
      [s.id, "You were interrupted by an Agent Rishi restart; continue where you left off."],
    ]);
  });
});
