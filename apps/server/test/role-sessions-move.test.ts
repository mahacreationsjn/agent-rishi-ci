import { describe, expect, it } from "vitest";
import { askMarker } from "../src/services/orchestration/asks";
import { deferred, withRoles } from "./support/role-env";

const text = (value: string) => ({
  input: { text: value, attachments: [] },
  whenBusy: "queue" as const,
});

describe("role sessions: concurrent use just after the provider setting changed (§8.1)", () => {
  // The first caller's new session has either settled or is still starting when the second
  // caller gets its turn. Each caller once retired the old session and created one of its own:
  // two live PMs in the first timing, `409 Could not start the pm session` in the second.
  for (const timing of ["settled", "still starting"] as const) {
    it(
      `gives two concurrent callers the same new session (the first one ${timing})`,
      withRoles(async ({ roles, repo, setQuietly, settle, livePms, stopped, holdStop }) => {
        const old = await roles.ensure("pm", "p1");
        settle(old.id, "failed");
        // The setting has changed and nothing has acted on it yet: a wake and a message arrive.
        setQuietly({ providers: { pm: { provider: "codex" } } });
        const gate = deferred();
        // A second stop of the old session, if there is one, ends after the first caller is done.
        holdStop(2, gate.promise);

        const wake = roles.ensure("pm", "p1");
        const message = roles.ensure("pm", "p1");
        const outcome = message.then(
          (session) => ({ session }),
          (error: unknown) => ({ error: String(error) }),
        );
        const first = await wake;
        if (timing === "settled") settle(first.id);
        gate.resolve();

        expect(await outcome).toEqual({ session: first });
        expect(first.provider).toBe("codex");
        expect(livePms().map((s) => s.id)).toEqual([first.id]);
        expect(repo.get(old.id).archivedAt).not.toBeNull();
        expect(stopped).toEqual([old.id]);
        expect((await roles.ensure("pm", "p1")).id).toBe(first.id);
      }),
    );
  }

  it(
    "gives a caller that arrives while the settings change retires the session a new one",
    withRoles(async ({ roles, set, settle, livePms, holdStop }) => {
      const old = await roles.ensure("pm", "p1");
      settle(old.id);
      const gate = deferred();
      holdStop(1, gate.promise);
      // Nothing is queued, so the settings change retires the session and starts none.
      const applied = set({ providers: { pm: { provider: "codex" } } });
      const message = roles.ensure("pm", "p1");
      gate.resolve();
      await applied;
      const session = await message;
      expect(session.provider).toBe("codex");
      expect(livePms().map((s) => s.id)).toEqual([session.id]);
    }),
  );
});

describe("role sessions: the queue moves with the role (§8.1)", () => {
  it(
    "moves the user's message, a message_pm task and an ask_pm question to the new session, each with its sender, and the ask is answered from there",
    withRoles(async ({ roles, sessions, asks, set, settle, queue, turn, livePms }) => {
      const old = await roles.ensure("pm", "p1");
      // The PM's provider is broken: its first turn failed, and one message is on its way, so
      // what arrives now waits in the queue.
      settle(old.id, "running");
      await sessions.send(old.id, text("user: please look at issue 12"), "user");
      await sessions.send(old.id, text("task from the orchestrator"), "orchestrator");
      const question = `Question from the orchestrator ${askMarker("abcd1234")}:\nIs the build green?`;
      asks.register("abcd1234", { pmSessionId: old.id, projectId: "p1", fromSessionId: null });
      const answer = asks.wait("abcd1234", 60_000);
      await sessions.send(old.id, text(question), "orchestrator");
      settle(old.id, "failed");
      const waiting = [
        { from: "user", text: "user: please look at issue 12" },
        { from: "orchestrator", text: "task from the orchestrator" },
        { from: "orchestrator", text: question },
      ];
      expect(queue(old.id)).toEqual(waiting);

      // Saving the setting is enough: with messages to hand over, the new session starts now.
      await set({ providers: { pm: { provider: "codex" } } });

      const [next] = livePms();
      expect(livePms()).toHaveLength(1);
      expect(next?.id).not.toBe(old.id);
      expect(next?.provider).toBe("codex");
      expect(queue(old.id)).toEqual([]);
      expect(queue(next?.id as string)).toEqual(waiting);
      expect((await roles.ensure("pm", "p1")).id).toBe(next?.id);

      // The new PM's turn that takes the question answers the waiting `ask_pm` call.
      turn(next?.id as string, "turn-1", question, "Yes, the build is green.");
      expect(await answer).toEqual({ status: "answered", text: "Yes, the build is green." });
    }),
  );

  it(
    "answers an ask_pm that was open for a session retired with an empty queue",
    withRoles(async ({ roles, asks, set, settle, turn }) => {
      const old = await roles.ensure("pm", "p1");
      settle(old.id);
      // A question the loop guard holds back: tracked for the PM's session, not yet sent.
      const question = `Question from the orchestrator ${askMarker("0123abcd")}:\nAny news?`;
      asks.register("0123abcd", { pmSessionId: old.id, projectId: "p1", fromSessionId: null });
      const answer = asks.wait("0123abcd", 60_000);
      // Nothing is queued, so the settings change starts no session.
      await set({ providers: { pm: { provider: "codex" } } });
      expect(roles.find("pm", "p1")).toBeUndefined();

      // The held question is delivered later, to the session the role then gets.
      const next = await roles.ensure("pm", "p1");
      turn(next.id, "turn-1", question, "No news.");
      expect(await Promise.race([answer, Promise.resolve("unanswered")])).toEqual({
        status: "answered",
        text: "No news.",
      });
    }),
  );

  it(
    "hands the queue over when the role is next used, ahead of the message that uses it",
    withRoles(async ({ roles, sessions, setQuietly, settle, queue }) => {
      const old = await roles.ensure("orchestrator", null);
      settle(old.id, "running");
      await sessions.send(old.id, text("first"), "user");
      await sessions.send(old.id, text("second"), "pm");
      settle(old.id, "failed");
      setQuietly({ providers: { orchestrator: { provider: "codex" } } });

      const next = await roles.ensure("orchestrator", null);
      await sessions.send(next.id, text("third"), "user");
      expect(queue(next.id)).toEqual([
        { from: "user", text: "first" },
        { from: "pm", text: "second" },
        { from: "user", text: "third" },
      ]);
    }),
  );

  it(
    "keeps the messages in the old session when it can't be stopped or the new one can't start",
    withRoles(async ({ roles, repo, sessions, set, settle, queue, logged }) => {
      const old = await roles.ensure("pm", "p1");
      settle(old.id, "running");
      await sessions.send(old.id, text("keep me"), "user");
      settle(old.id, "failed");

      const stop = sessions.stop.bind(sessions);
      sessions.stop = async () => {
        throw new Error("runner busy");
      };
      await set({ providers: { pm: { provider: "codex" } } });
      expect(repo.get(old.id).archivedAt).toBeNull();
      expect(queue(old.id)).toEqual([{ from: "user", text: "keep me" }]);
      expect(logged.join("\n")).toContain("runner busy");

      sessions.stop = stop;
      const start = sessions.start.bind(sessions);
      sessions.start = async () => {
        throw new Error("provider can't run a PM");
      };
      await expect(roles.ensure("pm", "p1")).rejects.toThrow("provider can't run a PM");
      expect(roles.find("pm", "p1")?.id).toBe(old.id);
      expect(queue(old.id)).toEqual([{ from: "user", text: "keep me" }]);

      sessions.start = start;
      const next = await roles.ensure("pm", "p1");
      expect(next.provider).toBe("codex");
      expect(queue(next.id)).toEqual([{ from: "user", text: "keep me" }]);
    }),
  );
});
