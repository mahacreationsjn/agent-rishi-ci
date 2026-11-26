import {
  type AgentEvent,
  agentEventToNewEvent,
  defaultSettings,
  type ErrorInfo,
  type ProviderInfo,
  type RawEventEnvelope,
  type RunnerCommand,
  type StartedBy,
  type UserInput,
} from "@agent-rishi/contracts";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { deriveNotices } from "../src/services/orchestration/notices";
import { AutoRetry } from "../src/services/sessions/auto-retry";
import { SessionService, type SessionServiceDeps } from "../src/services/sessions/session-service";
import { createGithubEnv, type GithubEnv } from "./support/github-env";

/**
 * Compaction turns (#413): "Compact now" and the compaction between scout rounds run as turns of
 * their own. They are not work: a failed one is never continued, a finished one tells nobody it
 * finished, and a steer can't land in one.
 */

const T = "t-root";

/**
 * The events a compaction produces (the Fake's `runCompaction`): no user message, the notice,
 * on a turn the runner marks `kind: "compact"` (`SessionHost.compact`).
 */
const compaction = (turnId: string, end: AgentEvent): AgentEvent[] => [
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
  end,
];
const failed = (turnId: string, error: ErrorInfo): AgentEvent => ({
  type: "turn.failed",
  threadId: T,
  turnId,
  error,
});
const completed = (turnId: string): AgentEvent => ({
  type: "turn.completed",
  threadId: T,
  turnId,
  stopReason: "end_turn",
});

/** A normal work turn: the user's message, the agent's answer. */
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
      input: { text: "Do the work", attachments: [] },
    },
  },
  {
    type: "item.completed",
    threadId: T,
    turnId,
    item: { id: `${turnId}-reply`, kind: "assistant_message", status: "completed", text: "Done" },
  },
  completed(turnId),
];

let env: GithubEnv;

beforeEach(() => {
  env = createGithubEnv();
});
afterEach(async () => {
  await env.close();
});

const agent = (sessionId: string, ...events: AgentEvent[]) =>
  env.store.append(events.map((e) => agentEventToNewEvent(sessionId, e)));
const newSession = (startedBy: StartedBy = { kind: "user" }) => {
  const s = env.addSession({ status: "running", startedBy });
  agent(s.id, { type: "thread.started", thread: { id: T } });
  return s.id;
};
const tick = () => new Promise((r) => setImmediate(r));

describe("a compaction that fails", () => {
  let sent: Array<{ sessionId: string; input: UserInput }>;
  let retry: AutoRetry;

  beforeEach(() => {
    sent = [];
    retry = new AutoRetry({
      db: env.db.db,
      store: env.store,
      repo: env.repo,
      inbox: env.inbox,
      settings: () => defaultSettings(),
      send: async (sessionId, input) => {
        sent.push({ sessionId, input });
      },
      delaysMs: [20, 20, 20],
      usageMarginMs: 10,
    });
    retry.start();
  });
  afterEach(() => retry.stop());

  const cases: Array<[string, ErrorInfo]> = [
    [
      "on a usage limit",
      {
        message: "Usage limit",
        kind: "usage_limit",
        retryable: true,
        retryAt: new Date(Date.now() + 20).toISOString(),
      },
    ],
    ["when the provider process exits", { message: "Codex exited", kind: "transient" }],
    ["for any other reason", { message: "boom" }],
  ];
  for (const [when, error] of cases) {
    it(`${when} is not continued, and the session stays idle with the error`, async () => {
      const id = newSession();
      agent(id, ...workTurn("u1"));
      agent(id, ...compaction("c1", failed("c1", error)));
      await tick();
      // No retry is scheduled: "continue where you left off" would re-run the finished task.
      expect(retry.pending()).toEqual([]);
      expect(env.repo.item(id, "auto-retry-c1")).toBeUndefined();
      expect(sent).toEqual([]);
      expect(env.repo.get(id).status).toBe("idle");
      expect(env.inbox.list().filter((i) => i.kind === "run_failed")).toEqual([]);
      // The error stays on the compaction turn, which the transcript shows as such.
      expect(env.repo.turn(id, "c1")).toMatchObject({ kind: "compact", status: "failed", error });
    });
  }

  it("leaves a work turn that fails after it to auto-retry, counting from there", async () => {
    const id = newSession();
    agent(id, ...compaction("c1", failed("c1", { message: "Codex exited", kind: "transient" })));
    agent(
      id,
      { type: "turn.started", threadId: T, turnId: "u2" },
      failed("u2", { message: "API overloaded (529)", kind: "transient" }),
    );
    await tick();
    expect(retry.pending()).toEqual([id]);
    expect(env.repo.turn(id, "u2")?.kind).toBeNull();
    const notice = env.repo.item(id, "auto-retry-u2")?.item;
    expect(notice?.kind === "notice" && notice.message).toMatch(/\(attempt 1 of 3\)/);
  });
});

describe("PM notices", () => {
  const noticesFor = (envelopes: RawEventEnvelope[]) =>
    deriveNotices(envelopes, {
      session: (id) => env.repo.find(id)?.session,
      finalMessage: () => null,
      turnKind: (sessionId, turnId) => env.repo.turn(sessionId, turnId)?.kind,
    }).map((d) => [d.notice.id, d.notice.target, d.wake]);

  it("a finished compaction sends no Finished notice and wakes nobody", () => {
    const id = newSession({ kind: "pm", id: "pm-1" });
    expect(noticesFor(agent(id, ...compaction("c1", completed("c1"))))).toEqual([]);
  });

  it("nor does it report to the orchestrator", () => {
    const id = newSession({ kind: "pm", id: "pm-1", reportTo: "orchestrator" });
    env.repo.update(id, (s) => ({
      ...s,
      result: { outcome: "success", summary: "Audit done", at: "2026-11-15T10:00:00.000Z" },
    }));
    expect(noticesFor(agent(id, ...compaction("c1", completed("c1"))))).toEqual([]);
    expect(noticesFor(agent(id, ...workTurn("u2")))).toEqual([
      [`session.finished:${id}:u2`, "pm", true],
      [`session.finished:orchestrator:${id}:2026-11-15T10:00:00.000Z`, "orchestrator", true],
    ]);
  });

  it("a normal turn still sends its Finished notice and wakes the PM", () => {
    const id = newSession({ kind: "pm", id: "pm-1" });
    expect(noticesFor(agent(id, ...workTurn("u1")))).toEqual([
      [`session.finished:${id}:u1`, "pm", true],
    ]);
  });
});

describe("steering during a compaction", () => {
  const caps = {
    resume: true,
    steer: true,
    interrupt: true,
    approvals: true,
    userQuestions: false,
    subagents: false,
    rollback: false,
    fork: false,
    images: false,
    planMode: false,
    reasoningEffort: false,
    mcp: true,
    skills: false,
    compact: true,
  } satisfies ProviderInfo["capabilities"];

  const input: UserInput = { text: "Also fix the docs", attachments: [] };
  let steers: RunnerCommand[];
  let queued: UserInput[];
  /** What the runner answers `session.steer` with. */
  let runnerSteer: () => void;

  const service = () =>
    new SessionService({
      repo: env.repo,
      runner: {
        providers: (): ProviderInfo[] => [
          { id: "codex", displayName: "Codex", models: [], capabilities: caps },
        ],
        isConnected: () => true,
        request: async (command: RunnerCommand) => {
          if (command.name === "session.steer") {
            steers.push(command);
            runnerSteer();
          }
          return {};
        },
      },
      outbox: {
        reserve: () => new Date().toISOString(),
        count: () => queued.length,
        push: (_id: string, message: UserInput) => queued.push(message),
      },
      artifacts: {
        externalizeAttachments: (i: UserInput) => i,
        resolveAttachments: (i: UserInput) => i,
      },
    } as unknown as SessionServiceDeps);

  /** A Codex session whose compaction turn has started (and not ended). */
  const compacting = () => {
    const s = env.addSession({ status: "running", provider: "codex", resumeToken: "thread-1" });
    agent(s.id, { type: "thread.started", thread: { id: T } });
    agent(s.id, ...compaction("c1", completed("c1")).slice(0, 2));
    expect(env.repo.get(s.id).status).toBe("running");
    return s.id;
  };

  beforeEach(() => {
    steers = [];
    queued = [];
    // What Codex answers `turn/steer` during a compaction, as the runner used to pass it on.
    runnerSteer = () => {
      throw Object.assign(new Error("active turn is not steerable (compact)"), {
        code: "command_failed",
      });
    };
  });

  it("is refused with a clear message, never a raw 502", async () => {
    const id = compacting();
    const refused = await service()
      .steer(id, input)
      .catch((error: unknown) => error);
    expect(refused).toMatchObject({ status: 409, code: "compacting" });
    expect((refused as Error).message).toMatch(/being compacted.*goes once the compaction ends/);
    expect(steers).toEqual([]);
  });

  it("from the composer or the PM (send, whenBusy steer) is queued until it ends", async () => {
    const id = compacting();
    expect(await service().send(id, { input, whenBusy: "steer" })).toEqual({ status: "queued" });
    expect(queued).toEqual([input]);
    expect(steers).toEqual([]);
  });

  it("is queued too when the runner is the first to know (it answers `compacting`)", async () => {
    const s = env.addSession({ status: "running", provider: "codex", resumeToken: "thread-1" });
    runnerSteer = () => {
      throw Object.assign(new Error("The conversation is being compacted"), { code: "compacting" });
    };
    await expect(service().steer(s.id, input)).rejects.toMatchObject({
      status: 409,
      code: "compacting",
    });
    expect(await service().send(s.id, { input, whenBusy: "steer" })).toEqual({ status: "queued" });
    expect(queued).toEqual([input]);
  });

  it("a work turn is still steered as before", async () => {
    const s = env.addSession({ status: "running", provider: "codex", resumeToken: "thread-1" });
    agent(s.id, { type: "thread.started", thread: { id: T } });
    agent(s.id, workTurn("u1")[0] as AgentEvent);
    runnerSteer = () => {};
    expect(await service().send(s.id, { input, whenBusy: "steer" })).toEqual({
      status: "steered",
    });
    expect(steers).toHaveLength(1);
  });
});
