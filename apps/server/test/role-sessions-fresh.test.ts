import type { InboxItem } from "@agent-rishi/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ServiceError } from "../src/services/errors";
import { NoticeCards } from "../src/services/orchestration/cards";
import { NoticeDelivery } from "../src/services/orchestration/delivery";
import { NoticeStore } from "../src/services/orchestration/notices";
import {
  WorktreeCleanup,
  type WorktreeCleanupDeps,
} from "../src/services/sessions/worktree-cleanup";
import { deferred, withRoles } from "./support/role-env";

const text = (value: string) => ({
  input: { text: value, attachments: [] },
  whenBusy: "queue" as const,
});

/** The error code a rejected promise carries. */
const codeOf = (promise: Promise<unknown>) =>
  promise.then(
    () => "resolved",
    (error: unknown) => (error instanceof ServiceError ? error.code : String(error)),
  );

const question = (id: string, sessionId: string): InboxItem => {
  const at = new Date().toISOString();
  return {
    id,
    kind: "question",
    status: "open",
    priority: "normal",
    notify: "needs_you",
    title: "Which branch?",
    body: null,
    projectId: "p1",
    sessionId,
    threadId: null,
    itemId: null,
    requestId: "req-1",
    issue: null,
    pr: null,
    automationRunId: null,
    createdAt: at,
    updatedAt: at,
    resolvedAt: null,
    resolution: null,
  };
};

afterEach(() => {
  vi.useRealTimers();
});

describe("role sessions: Start fresh (§8.1)", () => {
  it(
    "archives the PM's session and starts exactly one new one, same work key, on the provider and model in settings",
    withRoles(async ({ roles, repo, setQuietly, settle, livePms, stopped }) => {
      const old = await roles.ensure("pm", "p1");
      settle(old.id);
      // The settings name another provider and model since the PM started: Start fresh uses them.
      setQuietly({ providers: { pm: { provider: "codex", model: "codex-large" } } });

      const { session, archived } = await roles.startFresh("pm", "p1", old.id);

      expect(archived.id).toBe(old.id);
      expect(repo.get(old.id).archivedAt).not.toBeNull();
      expect(repo.get(old.id).status).toBe("stopped");
      expect(stopped).toEqual([old.id]);
      expect(livePms().map((s) => s.id)).toEqual([session.id]);
      expect(session.id).not.toBe(old.id);
      expect(session).toMatchObject({
        role: "pm",
        projectId: "p1",
        workKey: old.workKey,
        provider: "codex",
        model: "codex-large",
      });
      // The role's next use (a message, a wake) gets the new session.
      expect((await roles.ensure("pm", "p1")).id).toBe(session.id);
      // A second click names the archived session: refused, nothing else is created.
      expect(await codeOf(roles.startFresh("pm", "p1", old.id))).toBe("not_current");
      expect(livePms().map((s) => s.id)).toEqual([session.id]);
    }),
  );

  it(
    "starts the orchestrator fresh too",
    withRoles(async ({ roles, repo, settle }) => {
      const old = await roles.ensure("orchestrator", null);
      settle(old.id, "failed");
      const { session } = await roles.startFresh("orchestrator", null, old.id);
      expect(session.workKey).toBe("orchestrator:main");
      expect(repo.get(old.id).archivedAt).not.toBeNull();
      expect(roles.find("orchestrator", null)?.id).toBe(session.id);
    }),
  );

  it(
    "is refused while the PM starts, runs a turn or waits on a question, and archives nothing",
    withRoles(async ({ roles, repo, inbox, settle, livePms, stopped }) => {
      const old = await roles.ensure("pm", "p1");
      // Still starting (the scripted runner never finishes a start by itself).
      expect(await codeOf(roles.startFresh("pm", "p1", old.id))).toBe("turn_running");
      settle(old.id, "running");
      expect(await codeOf(roles.startFresh("pm", "p1", old.id))).toBe("turn_running");
      settle(old.id, "waiting");
      expect(await codeOf(roles.startFresh("pm", "p1", old.id))).toBe("request_open");
      // Idle, with a question still open in the inbox (an `ask_user` that returned pending).
      settle(old.id);
      inbox.put(question("q1", old.id));
      expect(await codeOf(roles.startFresh("pm", "p1", old.id))).toBe("request_open");

      expect(stopped).toEqual([]);
      expect(repo.get(old.id).archivedAt ?? null).toBeNull();
      expect(livePms().map((s) => s.id)).toEqual([old.id]);

      // Once the question is answered, it goes ahead.
      inbox.close(inbox.get("q1"), "resolved", { answers: {} });
      const { session } = await roles.startFresh("pm", "p1", old.id);
      expect(livePms().map((s) => s.id)).toEqual([session.id]);
    }),
  );

  it(
    "makes one new session when a second click, a wake and a message arrive while the old one stops",
    withRoles(async ({ roles, repo, sessions, settle, queue, livePms, commands, holdStop }) => {
      const old = await roles.ensure("pm", "p1");
      settle(old.id);
      const gate = deferred();
      holdStop(1, gate.promise);
      const first = roles.startFresh("pm", "p1", old.id);
      // The runner is still stopping the old session: it isn't archived yet.
      expect(repo.get(old.id).archivedAt ?? null).toBeNull();

      expect(await codeOf(roles.startFresh("pm", "p1", old.id))).toBe("conflict");
      // A wake or a message to the role waits for the change and gets the new session.
      const woken = roles.ensure("pm", "p1");
      // A message straight to the old session (its open chat) waits and moves over; a wake
      // (`reject`) is told to come back.
      expect(await sessions.send(old.id, text("one more thing"), "user")).toEqual({
        status: "queued",
      });
      expect(
        await codeOf(sessions.send(old.id, { ...text("wake"), whenBusy: "reject" }, "agent-rishi")),
      ).toBe("turn_running");

      gate.resolve();
      const { session } = await first;
      expect((await woken).id).toBe(session.id);
      expect(livePms().map((s) => s.id)).toEqual([session.id]);
      expect(commands.filter((c) => c === `session.send ${old.id}`)).toEqual([]);
      expect(queue(old.id)).toEqual([]);
      expect(queue(session.id)).toEqual([{ from: "user", text: "one more thing" }]);
    }),
  );

  it(
    "keeps the PM's wake-ups and notices about its work, and delivers them to the new session",
    withRoles(async ({ db, store, roles, settle }) => {
      vi.useFakeTimers({ toFake: ["Date"], now: new Date("2026-11-23T09:00:00Z") });
      const notices = new NoticeStore(db, store);
      const old = await roles.ensure("pm", "p1");
      settle(old.id);
      // A wake-up the old PM scheduled for later, and news of work it started.
      notices.create({
        id: "reminder:1",
        type: "reminder",
        projectId: "p1",
        target: "pm",
        sessionId: null,
        title: "Wake-up you scheduled",
        wake: true,
        notBefore: "2026-11-23T10:00:00.000Z",
        data: { note: "check the audit", requestedBy: old.id },
      });
      notices.create({
        id: "session.finished:child:t1",
        type: "session.finished",
        projectId: "p1",
        target: "pm",
        sessionId: "child",
        title: "Finished: Fix login",
        data: {
          sessionId: "child",
          workKey: "issue:12",
          purpose: "Fix login",
          startedBy: { kind: "pm", id: old.id },
          summary: "Login fixed",
          outcome: "success",
        },
      });

      const { session } = await roles.startFresh("pm", "p1", old.id);
      expect(notices.scheduled("pm", "p1").map((n) => n.id)).toEqual(["reminder:1"]);

      // The wake-up comes due: the wake (`roles.ensure`, then a turn) reaches the new session.
      vi.setSystemTime(new Date("2026-11-23T10:01:00Z"));
      const woken = await roles.ensure("pm", "p1");
      expect(woken.id).toBe(session.id);
      const delivery = new NoticeDelivery({
        db,
        notices,
        cards: new NoticeCards(store),
        wakes: { request: () => {} },
        digestFor: () => "digest",
        projectName: () => "app",
        session: () => undefined,
        projectIds: () => ["p1"],
      });
      const turn = delivery.decorate(woken, { text: "Automatic wake-up", attachments: [] });
      expect(turn.input.text).toContain("Wake-up you scheduled");
      expect(turn.input.text).toContain("Finished: Fix login");
      turn.delivered?.();
      expect(notices.undelivered("pm", "p1")).toEqual([]);
    }),
  );

  it(
    "never brings the archived session back: messages, a restart's carry-on and unarchive are refused",
    withRoles(async ({ roles, repo, sessions, settle, livePms, commands }) => {
      const old = await roles.ensure("pm", "p1");
      settle(old.id);
      const { session } = await roles.startFresh("pm", "p1", old.id);
      const before = commands.length;

      // From the old chat's composer, an inbox Retry, the factory: all refused.
      expect(await codeOf(sessions.send(old.id, text("are you there?"), "user"))).toBe(
        "role_session_archived",
      );
      expect(await codeOf(sessions.send(old.id, text("task"), "orchestrator"))).toBe(
        "role_session_archived",
      );
      await sessions.continueAfterRestart(old.id, "carry on");
      // The project's Archived list has no Unarchive for it, and the route refuses it too.
      const cleanup = new WorktreeCleanup({ repo } as unknown as WorktreeCleanupDeps);
      expect(() => cleanup.unarchive(old.id)).toThrow(/archived and read-only/);
      expect(commands.slice(before)).toEqual([]);
      expect(repo.get(old.id).archivedAt).not.toBeNull();
      expect(livePms().map((s) => s.id)).toEqual([session.id]);
    }),
  );
});
