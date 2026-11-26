import {
  type AgentEvent,
  agentEventToNewEvent,
  defaultSettings,
  type FollowupSuggestion,
} from "@agent-rishi/contracts";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { McpTokenStore } from "../src/mcp/tokens";
import { SessionLifecycle } from "../src/services/sessions/lifecycle";
import type { SessionService } from "../src/services/sessions/session-service";
import type { TurnContext, UtilityService } from "../src/services/utility";
import type { SettingsStore } from "../src/settings-store";
import {
  type ChecksEnv,
  createChecksEnv,
  fail,
  pass,
  until,
  user,
  wait,
} from "./support/checks-env";
import { createGithubEnv, type GithubEnv } from "./support/github-env";

/**
 * A finished compaction turn (#461, after #413) is not work: it changes no files and gives no
 * answer, so the session's checks don't run after it and the utility model isn't asked for
 * follow-ups (or a title) about it.
 */

describe("the checks loop after a compaction", () => {
  let c: ChecksEnv;

  beforeEach(() => {
    c = createChecksEnv();
  });
  afterEach(async () => {
    await c.close();
  });

  it("runs no checks after Compact now, so it never starts a round of work", async () => {
    // The checks pass after the agent's turn, and would fail when run again.
    c.script.set("pnpm test", [pass(), fail("FAIL src/a.test.ts")]);
    const id = c.newSession();
    const first = c.turn(id, user("Add the feature"));
    await until(c.ended(id, first));
    expect(c.card(id, first)?.data.outcome).toBe("passed");

    expect(await c.sessions.compact(id)).toEqual({ status: "compacting" });
    await until(() => c.turnCount() >= 2);
    const compaction = "u2";
    expect(c.env.repo.turn(id, compaction)).toMatchObject({ kind: "compact", status: "completed" });
    await wait(100);
    // No card on the compaction turn, no second run of the checks, no message to the agent.
    expect(c.card(id, compaction)).toBeUndefined();
    expect(c.checkRuns()).toEqual(["pnpm typecheck", "pnpm test"]);
    expect(c.sends()).toEqual([]);
    expect(c.turnCount()).toBe(2);
    expect(c.env.repo.get(id).status).toBe("idle");
  });
});

describe("utility hooks after a compaction", () => {
  const T = "t-root";
  let env: GithubEnv;
  let lifecycle: SessionLifecycle;
  /** The utility jobs asked about a turn, with the turn's final message. */
  let jobs: Array<[string, string | null]>;
  const suggestions: FollowupSuggestion[] = [{ prompt: "Add tests for it" }];

  const utility = {
    sessionTitle: async (ctx: TurnContext) => {
      jobs.push(["title", ctx.finalMessage]);
      // The utility model gave no title: the session stays untitled.
      return null;
    },
    suggestFollowups: async (ctx: TurnContext) => {
      jobs.push(["followups", ctx.finalMessage]);
      return suggestions;
    },
  } as unknown as UtilityService;

  beforeEach(() => {
    env = createGithubEnv();
    jobs = [];
    lifecycle = new SessionLifecycle({
      db: env.db.db,
      store: env.store,
      repo: env.repo,
      sessions: {
        hasOutbox: () => false,
        startQueued: () => undefined,
      } as unknown as SessionService,
      settings: { get: () => defaultSettings() } as unknown as SettingsStore,
      utility,
      tokens: { revokeSession: () => undefined } as unknown as McpTokenStore,
    });
    lifecycle.start();
  });
  afterEach(async () => {
    lifecycle.stop();
    await new Promise((resolve) => setImmediate(resolve));
    await env.close();
  });

  const agent = (sessionId: string, ...events: AgentEvent[]) =>
    env.store.append(events.map((e) => agentEventToNewEvent(sessionId, e)));
  const settle = () => wait(50);

  it("asks the utility model nothing about a finished compaction turn", async () => {
    const s = env.addSession({ status: "running", title: null });
    agent(s.id, { type: "thread.started", thread: { id: T } });
    agent(
      s.id,
      { type: "turn.started", threadId: T, turnId: "u1" },
      {
        type: "item.completed",
        threadId: T,
        turnId: "u1",
        item: {
          id: "u1-user",
          kind: "user_message",
          status: "completed",
          input: { text: "Do the work", attachments: [] },
        },
      },
      {
        type: "item.completed",
        threadId: T,
        turnId: "u1",
        item: { id: "u1-reply", kind: "assistant_message", status: "completed", text: "Done" },
      },
      { type: "turn.completed", threadId: T, turnId: "u1" },
    );
    await settle();
    // A work turn still gets its utility jobs (and the first message one for the title).
    expect(jobs).toEqual([
      ["title", null],
      ["title", "Done"],
      ["followups", "Done"],
    ]);
    expect(env.repo.item(s.id, "followups-u1")).toBeDefined();

    jobs = [];
    agent(
      s.id,
      { type: "turn.started", threadId: T, turnId: "c1", kind: "compact" },
      {
        type: "item.completed",
        threadId: T,
        turnId: "c1",
        item: {
          id: "c1-notice",
          kind: "notice",
          status: "completed",
          level: "info",
          code: "compacting",
          message: "Context compacted",
        },
      },
      { type: "turn.completed", threadId: T, turnId: "c1" },
    );
    await settle();
    expect(env.repo.turn(s.id, "c1")).toMatchObject({ kind: "compact", status: "completed" });
    expect(jobs).toEqual([]);
    expect(env.repo.item(s.id, "followups-c1")).toBeUndefined();
  });
});
