import { type ErrorInfo, PROVIDER_SWITCH_CODE, type Session } from "@agent-rishi/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { switchInboxId } from "../src/services/orchestration/role-limit-switch";
import type { SessionRepo } from "../src/services/sessions/repo";
import { type RoleEnv, withRoles } from "./support/role-env";
import { TEST_START } from "./support/test-clock";

const HOUR = 60 * 60_000;
/** When the limit in these tests resets: two hours after the pinned start. */
const RESET_AT = new Date(TEST_START.getTime() + 2 * HOUR).toISOString();

const text = (value: string) => ({
  input: { text: value, attachments: [] },
  whenBusy: "queue" as const,
});

const limit = (retryAt?: string): ErrorInfo => ({
  message: "You've hit your usage limit.",
  kind: "usage_limit",
  ...(retryAt && { retryAt }),
});

/** The `provider_switch` notices in a session's chat: reason and message. */
function switchNotices(repo: SessionRepo, session: Session) {
  return repo.rootItems(repo.get(session.id), ["notice"]).flatMap((item) => {
    if (item.kind !== "notice" || item.code !== PROVIDER_SWITCH_CODE) return [];
    return [{ reason: (item.data as { reason: string }).reason, message: item.message }];
  });
}

/** A PM on claude that was sent "Ship the fix" and then hit its usage limit. */
async function pmAtLimit(env: RoleEnv, retryAt?: string): Promise<Session> {
  const pm = await env.roles.ensure("pm", "p1");
  env.settle(pm.id);
  await env.sessions.send(pm.id, text("Ship the fix"), "user");
  env.failTurn(pm.id, "t1", limit(retryAt));
  await env.limits.idle();
  return pm;
}

const BOTH = [
  { id: "claude", readOnly: true },
  { id: "codex", readOnly: true },
];

beforeEach(() => {
  // The clock is pinned; only `Date` is faked, so the queue and the runner's promises run.
  vi.useFakeTimers({ toFake: ["Date"], now: TEST_START });
});

afterEach(() => {
  vi.useRealTimers();
});

describe("role sessions: switching provider at a usage limit (§8.1)", () => {
  it(
    "moves the PM to the next ready provider, sends the failed message again and says so",
    withRoles(async (env) => {
      env.providers(BOTH);
      const old = await pmAtLimit(env, RESET_AT);

      const [pm] = env.livePms();
      expect(env.livePms()).toHaveLength(1);
      expect(pm?.id).not.toBe(old.id);
      expect(pm?.provider).toBe("codex");
      expect(pm?.workKey).toBe(old.workKey);
      expect(env.repo.get(old.id).archivedAt).toBeTruthy();
      // The message of the failed turn waits for the new session's start.
      expect(env.queue(pm?.id as string)).toEqual([{ from: "user", text: "Ship the fix" }]);

      const message = "Switched from claude to codex: claude hit its usage limit (until 2026-01-15";
      expect(switchNotices(env.repo, old)[0]?.message).toContain(message);
      const item = env.inbox.find(switchInboxId("pm", "p1"));
      expect(item).toMatchObject({ status: "open", sessionId: pm?.id, projectId: "p1" });
      expect(item?.body).toContain(message);
      // The failed run on the limited provider no longer waits on the user.
      expect(env.inbox.list({ sessionId: old.id }).filter((i) => i.status === "open")).toEqual([]);

      // The new chat shows the notice once its first turn starts.
      env.turn(pm?.id as string, "t2", "Ship the fix", "On it.");
      expect(switchNotices(env.repo, pm as Session)).toEqual([
        { reason: "usage_limit", message: expect.stringContaining(message) },
      ]);
    }),
  );

  it(
    "takes the provider the role's setting names first, and messages queued meanwhile follow",
    withRoles(async (env) => {
      env.providers([...BOTH, { id: "gemini", readOnly: true }]);
      const old = await env.roles.ensure("pm", "p1");
      env.settle(old.id);
      env.setQuietly({ providers: { pm: { provider: "gemini" } } });
      await env.sessions.send(old.id, text("Ship the fix"), "user");
      await env.sessions.send(old.id, text("And the docs"), "orchestrator");
      env.failTurn(old.id, "t1", limit());
      await env.limits.idle();

      const [pm] = env.livePms();
      expect(pm?.provider).toBe("gemini");
      expect(env.queue(pm?.id as string)).toEqual([
        { from: "user", text: "Ship the fix" },
        { from: "orchestrator", text: "And the docs" },
      ]);
    }),
  );

  it(
    "doesn't switch when no other provider is ready, and says why",
    withRoles(async (env) => {
      env.providers(BOTH);
      env.ready(["claude"]);
      const old = await pmAtLimit(env, RESET_AT);

      expect(env.livePms().map((s) => [s.id, s.provider, s.status])).toEqual([
        [old.id, "claude", "failed"],
      ]);
      expect(env.stopped).toEqual([]);
      const [notice] = switchNotices(env.repo, old);
      expect(notice?.reason).toBe("no_fallback");
      expect(notice?.message).toContain("no other provider is ready to take over");
      // The failure is still the user's to see, as before.
      expect(env.inbox.list({ sessionId: old.id }).map((i) => [i.kind, i.status])).toEqual([
        ["run_failed", "open"],
      ]);
      expect(env.inbox.find(switchInboxId("pm", "p1"))).toBeUndefined();
    }),
  );

  it(
    "never moves a role to a provider that can't run read-only",
    withRoles(async (env) => {
      env.providers([
        { id: "claude", readOnly: true },
        { id: "opencode", readOnly: false },
        { id: "codex", readOnly: true },
      ]);
      // The setting names the provider that can't: it is skipped all the same.
      env.setQuietly({ providers: { agent: { provider: "opencode" } } });
      await pmAtLimit(env);
      const [pm] = env.livePms();
      // A PM session is opened read-only whatever its provider (the launcher, by role).
      expect([pm?.role, pm?.provider]).toEqual(["pm", "codex"]);

      // With only that provider left, nothing is switched.
      env.providers([
        { id: "codex", readOnly: true },
        { id: "opencode", readOnly: false },
      ]);
      env.settle(pm?.id as string);
      env.failTurn(pm?.id as string, "t2", limit());
      await env.limits.idle();
      expect(env.livePms().map((s) => s.id)).toEqual([pm?.id]);
    }),
  );

  it(
    "goes back to the role's provider on its next use once the limit has reset",
    withRoles(async (env) => {
      env.providers(BOTH);
      const old = await pmAtLimit(env, RESET_AT);
      const [fallback] = env.livePms();
      env.settle(fallback?.id as string);

      // Before the reset (and within the minute after it) the role stays on the fallback.
      vi.setSystemTime(new Date(TEST_START.getTime() + 2 * HOUR + 30_000));
      expect((await env.roles.ensure("pm", "p1")).id).toBe(fallback?.id);

      vi.setSystemTime(new Date(TEST_START.getTime() + 2 * HOUR + 61_000));
      const back = await env.roles.ensure("pm", "p1");
      expect(back.id).not.toBe(fallback?.id);
      expect(back.provider).toBe("claude");
      expect(env.livePms().map((s) => s.id)).toEqual([back.id]);
      expect(env.stopped).toEqual([old.id, fallback?.id]);
      const text = "Switched back from codex to claude: claude's usage limit has reset.";
      expect(env.inbox.find(switchInboxId("pm", "p1"))).toMatchObject({
        status: "open",
        sessionId: back.id,
        body: text,
      });
      env.turn(back.id, "t3", "Status?", "All green.");
      expect(switchNotices(env.repo, back)).toEqual([{ reason: "limit_reset", message: text }]);
      // It is the role's own provider again: nothing further moves it.
      env.settle(back.id);
      vi.setSystemTime(new Date(TEST_START.getTime() + 9 * HOUR));
      expect((await env.roles.ensure("pm", "p1")).id).toBe(back.id);
    }),
  );

  it(
    "never picks the provider that just hit its limit, even when its reset time has passed",
    withRoles(async (env) => {
      env.providers(BOTH);
      await pmAtLimit(env, new Date(TEST_START.getTime() - HOUR).toISOString());
      expect(env.livePms().map((s) => s.provider)).toEqual(["codex"]);
    }),
  );

  it(
    "a fallback that hits its own limit after the first reset goes back, as the role's own again",
    withRoles(async (env) => {
      env.providers(BOTH);
      await pmAtLimit(env, RESET_AT);
      const [fallback] = env.livePms();
      env.settle(fallback?.id as string);
      // Past the reset, inside the minute before the role would go back by itself.
      vi.setSystemTime(new Date(TEST_START.getTime() + 2 * HOUR + 30_000));
      env.failTurn(fallback?.id as string, "t2", limit());
      await env.limits.idle();
      const [home] = env.livePms();
      expect(home?.provider).toBe("claude");
      expect(env.repo.find(home?.id as string)?.startMeta?.fallback ?? null).toBeNull();

      // It isn't a fallback: nothing replaces it later.
      env.settle(home?.id as string);
      vi.setSystemTime(new Date(TEST_START.getTime() + 9 * HOUR));
      expect((await env.roles.ensure("pm", "p1")).id).toBe(home?.id);
    }),
  );

  it(
    "stays on the fallback without a reset time, until the provider setting is changed",
    withRoles(async (env) => {
      env.providers(BOTH);
      await pmAtLimit(env);
      const [fallback] = env.livePms();
      env.settle(fallback?.id as string);
      vi.setSystemTime(new Date(TEST_START.getTime() + 9 * HOUR));
      expect((await env.roles.ensure("pm", "p1")).id).toBe(fallback?.id);

      await env.set({ providers: { pm: { provider: "claude" } } });
      const chosen = await env.roles.ensure("pm", "p1");
      expect([chosen.id === fallback?.id, chosen.provider]).toEqual([false, "claude"]);
    }),
  );

  it(
    "does nothing when the setting is off, or for a failure that isn't a usage limit",
    withRoles(async (env) => {
      env.providers(BOTH);
      env.setQuietly({ providers: { autoSwitchOnLimit: false } });
      const old = await pmAtLimit(env, RESET_AT);
      expect(env.livePms().map((s) => [s.id, s.status])).toEqual([[old.id, "failed"]]);
      expect(switchNotices(env.repo, old)).toEqual([]);

      env.setQuietly({});
      env.settle(old.id);
      env.failTurn(old.id, "t2", { message: "Overloaded", kind: "transient" });
      await env.limits.idle();
      expect(env.livePms().map((s) => s.id)).toEqual([old.id]);
      expect(env.stopped).toEqual([]);
    }),
  );
});
