import { tmpdir } from "node:os";
import type { AgentEvent, RunnerEvent, SessionOptions, UserInput } from "@agent-rishi/contracts";
import {
  AsyncQueue,
  FakeProvider,
  type ProviderAdapter,
  ProviderRegistry,
  type ProviderSession,
  ProviderSessionError,
} from "@agent-rishi/providers";
import { afterEach, describe, expect, it } from "vitest";
import { SessionHost } from "../src/session-host";

const options: SessionOptions = {
  sessionId: "s1",
  role: "agent",
  cwd: tmpdir(),
  autonomy: "auto",
  mcpServers: [],
  additionalDirectories: [],
  planMode: false,
};

const THREAD = "root";

let host: SessionHost | undefined;
afterEach(async () => {
  await host?.closeAll();
  host = undefined;
});

/** Wait until `check` holds, polling the event loop. */
async function until(check: () => boolean): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (!check()) {
    if (Date.now() > deadline) throw new Error("timed out");
    await new Promise((r) => setImmediate(r));
  }
}

/**
 * A scripted session whose `compact()` fails, and which can start a root turn on its own, as a
 * provider does when its CLI begins one itself (a background task finishing, a queued prompt).
 * Without `turnFirst` no compaction turn starts (Codex starting none in time, OpenCode's compact
 * request failing); with it, the compaction's turn starts and fails before `compact()` rejects.
 */
function scripted(opts: { turnFirst?: boolean } = {}) {
  const events = new AsyncQueue<AgentEvent>();
  const steered: UserInput[] = [];
  let turns = 0;
  /** The provider starts a root turn by itself; returns its id. */
  const startTurn = (): string => {
    turns += 1;
    const turnId = `turn-${turns}`;
    events.push({ type: "turn.started", threadId: THREAD, turnId });
    return turnId;
  };
  const endTurn = (turnId: string) =>
    events.push({ type: "turn.completed", threadId: THREAD, turnId });
  const session: ProviderSession = {
    events,
    send: async () => {},
    steer: async (input) => {
      steered.push(input);
    },
    interrupt: async () => {},
    compact: async () => {
      if (opts.turnFirst) {
        // Something reported first, so the turn's start still waits in the event queue.
        events.push({ type: "session.updated", model: "scripted-model" });
        const turnId = startTurn();
        const error = { code: "compact_failed", message: "Compaction failed" };
        events.push({ type: "turn.failed", threadId: THREAD, turnId, error });
      }
      throw new ProviderSessionError("compact_failed", "The provider couldn't compact");
    },
    respond: async () => {},
    close: async () => events.close(),
    resumeToken: () => "scripted-1",
  };
  const adapter: ProviderAdapter = {
    id: "scripted",
    displayName: "Scripted",
    detect: () => new FakeProvider().detect(),
    capabilities: () => new FakeProvider().capabilities(),
    models: () => [],
    openSession: async () => {
      events.push({ type: "thread.started", thread: { id: THREAD } });
      return session;
    },
  };
  return { adapter, steered, startTurn, endTurn };
}

async function startHost(
  adapter: ProviderAdapter,
): Promise<{ h: SessionHost; events: AgentEvent[] }> {
  const events: AgentEvent[] = [];
  const emit = (e: RunnerEvent) => {
    if (e.kind === "agent") events.push(e.event);
  };
  const h = new SessionHost(new ProviderRegistry([adapter]), emit);
  host = h;
  await h.start({
    name: "session.start",
    sessionId: "s1",
    providerId: "scripted",
    options,
    checkpoints: false,
  });
  await until(() => events.some((e) => e.type === "thread.started"));
  return { h, events };
}

const kinds = (events: AgentEvent[]) =>
  events.flatMap((e) => (e.type === "turn.started" ? [e.kind ?? "work"] : []));

/** The provider starts a turn of its own (no message sent): it is work, and can be steered. */
async function ownTurnIsWork(
  h: SessionHost,
  provider: ReturnType<typeof scripted>,
  events: AgentEvent[],
): Promise<void> {
  const turnId = provider.startTurn();
  await until(() => events.some((e) => e.type === "turn.started" && e.turnId === turnId));
  expect(events.find((e) => e.type === "turn.started" && e.turnId === turnId)).not.toHaveProperty(
    "kind",
  );
  const input: UserInput = { text: "and also", attachments: [] };
  await h.steer({ name: "session.steer", sessionId: "s1", input });
  expect(provider.steered).toEqual([input]);
  provider.endTurn(turnId);
  await until(() => events.some((e) => e.type === "turn.completed" && e.turnId === turnId));
}

describe("a compaction that fails", () => {
  it("without starting a turn leaves no mark: the provider's next turn is work", async () => {
    const provider = scripted();
    const { h, events } = await startHost(provider.adapter);
    await expect(h.compact("s1")).rejects.toMatchObject({ code: "compact_failed" });
    await ownTurnIsWork(h, provider, events);
    expect(kinds(events)).toEqual(["work"]);
  });

  it("after its turn started keeps that turn the compaction, and only that one", async () => {
    const provider = scripted({ turnFirst: true });
    const { h, events } = await startHost(provider.adapter);
    await expect(h.compact("s1")).rejects.toMatchObject({ code: "compact_failed" });
    expect(kinds(events)).toEqual(["compact"]);
    await ownTurnIsWork(h, provider, events);
    expect(kinds(events)).toEqual(["compact", "work"]);
  });
});
