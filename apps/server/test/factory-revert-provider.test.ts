import type { FactoryItem, RunnerEventMessage } from "@agent-rishi/contracts";
import { afterEach, describe, expect, it } from "vitest";
import { ingestRunnerEvent } from "../src/events/ingest";
import { createFactoryEnv, type FactoryEnv } from "./support/factory-env";
import { factorySteps } from "./support/factory-steps";

/**
 * The agent writing an automatic revert (#535) always started on the default provider: a
 * signed-out (or usage-limited, or too old) provider took all of the revert's starts while another
 * provider was free, so main stayed red and the loop stayed paused until a person stepped in.
 */

let env: FactoryEnv;
afterEach(() => env?.close());

const s = factorySteps(() => env);
const revertOf = (id: string) =>
  env.factory.data
    .items(env.project.id)
    .find((i) => i.source === "revert" && i.revertOf === id) as FactoryItem;
const providerOf = (sessionId: string | null) => env.repo.get(sessionId as string).provider;
const revertStarts = () => env.starts.filter((r) => r.workKey?.startsWith("factory:revert:"));
const failedStarts = (item: FactoryItem) =>
  Object.keys(item.nudges).filter((k) => k.startsWith("revert_start_failed_"));

/** Let the background provider detection finish. */
const settle = () => new Promise((r) => setImmediate(r));

/** Detection reports these providers signed out (`{}`: signed in again), and is run now. */
async function signedOut(providers: Record<string, boolean>) {
  for (const [id, out] of Object.entries(providers))
    env.detected[id] = out ? { loggedIn: false } : {};
  env.factory.ctx.sessions.recheckProviders();
  await settle();
}

/** The runner's crash for a session the provider refused to open because it is signed out. */
let seq = 0;
function refusedSignedOut(sessionId: string) {
  const msg: RunnerEventMessage = {
    type: "event",
    seq: ++seq,
    ts: new Date().toISOString(),
    event: {
      kind: "session.process",
      sessionId,
      state: "crashed",
      error: { code: "open_failed", message: "Not logged in. Run `claude login`.", kind: "auth" },
    },
  };
  ingestRunnerEvent(env.db.db, env.store, "home", msg);
}

/** A dark-factory merge whose CI on main then fails; the revert can't be opened via the API. */
async function mergedThenRed() {
  env = createFactoryEnv({ providers: ["claude", "codex"] });
  env.gh.canRevertViaApi = false;
  s.enable("dark_factory");
  const created = s.backlogItem("Group the list");
  await s.tick();
  const builder = s.item(created.id).builderSessionId as string;
  env.gh.openPr({
    sessionId: builder,
    title: created.title,
    files: ["src/lists.ts", "test/lists.test.ts"],
  });
  await env.setStatus(builder, "idle");
  await s.tick();
  await s.review(created.id);
  await s.tick();
  const merged = s.item(created.id);
  expect(merged.stage).toBe("watching");
  env.gh.commitState.set(merged.mergeSha as string, "failure");
  env.gh.main.checks = "failure";
  return created.id;
}

describe("the agent writing an automatic revert (#535)", () => {
  it("starts on an available provider when the default one is signed out", async () => {
    const id = await mergedThenRed();
    await signedOut({ claude: true });
    expect(env.factory.providerRunnable("claude").runnable).toBe(false);
    await s.tick();
    const revert = revertOf(id);
    expect(revert.stage).toBe("building");
    expect(providerOf(revert.builderSessionId)).toBe("codex");
    expect(revert.builderProvider).toBe("codex");
  });

  it("waits without counting a failed start while no provider is available, then starts", async () => {
    const id = await mergedThenRed();
    await signedOut({ claude: true, codex: true });
    await s.tick();
    const revert = revertOf(id);
    expect(revert).toMatchObject({ stage: "backlog", builderSessionId: null });
    expect(revert.note).toMatch(/^Waiting: no revert provider available/);
    expect(env.factory.data.loopOrNew(env.project.id).pausedReason).toMatch(
      /no provider is available to write the revert yet/,
    );
    // More ticks than it has starts: none is used up, and it never fails as stuck.
    for (let n = 0; n < 4; n++) await s.tick();
    expect(s.item(revert.id)).toMatchObject({ stage: "backlog", failureKind: null });
    expect(s.item(revert.id).note).toMatch(/^Waiting: no revert provider available/);
    expect(failedStarts(s.item(revert.id))).toEqual([]);
    expect(revertStarts()).toHaveLength(0);
    // Codex is signed in again: the revert starts on it on the next tick.
    await signedOut({ codex: false });
    await s.tick();
    expect(s.item(revert.id).stage).toBe("building");
    expect(providerOf(s.item(revert.id).builderSessionId)).toBe("codex");
  });

  it("starts again on another provider after the default one refused it as signed out", async () => {
    const id = await mergedThenRed();
    await s.tick();
    const revert = revertOf(id);
    const first = revert.builderSessionId as string;
    expect(providerOf(first)).toBe("claude");
    // Claude is signed out: it refuses to open the session, and is backed off for new work.
    refusedSignedOut(first);
    await s.tick();
    expect(s.item(revert.id).stage).toBe("backlog");
    expect(env.factory.providerRunnable("claude")).toMatchObject({
      runnable: false,
      reason: "not signed in",
    });
    // The retry goes to Codex, which was free all along, not back to the signed-out provider.
    await s.tick();
    const retried = s.item(revert.id);
    expect(retried.stage).toBe("building");
    expect(retried.builderSessionId).not.toBe(first);
    expect(providerOf(retried.builderSessionId)).toBe("codex");
    expect(retried.builderProvider).toBe("codex");
    expect(failedStarts(retried)).toHaveLength(1);
    // The first start is the builder's choice (`auto`: the default provider), the retry Codex.
    expect(revertStarts().map((r) => r.provider)).toEqual(["auto", "codex"]);
  });
});
