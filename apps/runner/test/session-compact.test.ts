import { tmpdir } from "node:os";
import type { AgentEvent, RunnerEvent, SessionOptions } from "@agent-rishi/contracts";
import { FakeProvider, ProviderRegistry } from "@agent-rishi/providers";
import { afterEach, describe, expect, it } from "vitest";
import { CommandError } from "../src/errors";
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

let host: SessionHost | undefined;
afterEach(async () => {
  await host?.closeAll();
  host = undefined;
});

/** Wait until `check` holds, polling the event loop (the Fake runs on setImmediate). */
async function until(check: () => boolean): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (!check()) {
    if (Date.now() > deadline) throw new Error("timed out");
    await new Promise((r) => setImmediate(r));
  }
}

async function startHost(): Promise<{ h: SessionHost; events: AgentEvent[] }> {
  const events: AgentEvent[] = [];
  const emit = (e: RunnerEvent) => {
    if (e.kind === "agent") events.push(e.event);
  };
  const h = new SessionHost(new ProviderRegistry([new FakeProvider({ followups: false })]), emit);
  host = h;
  await h.start({
    name: "session.start",
    sessionId: "s1",
    providerId: "fake",
    options,
    checkpoints: false,
  });
  return { h, events };
}

const send = (h: SessionHost, text: string) =>
  h.send({ name: "session.send", sessionId: "s1", input: { text, attachments: [] } });
const ended = (events: AgentEvent[]) =>
  events.filter((e) => e.type === "turn.completed" || e.type === "turn.failed").length;
const kinds = (events: AgentEvent[]) =>
  events.flatMap((e) => (e.type === "turn.started" ? [e.kind ?? "work"] : []));

describe("session.compact", () => {
  it("marks the turn the compaction starts, and only that one", async () => {
    const { h, events } = await startHost();
    await send(h, "hi");
    await until(() => ended(events) === 1);
    await h.compact("s1");
    await until(() => ended(events) === 2);
    await send(h, "go");
    await until(() => ended(events) === 3);
    expect(kinds(events)).toEqual(["work", "compact", "work"]);
  });

  it("marks a compaction that fails, and the next message's turn is work again", async () => {
    const { h, events } = await startHost();
    await send(h, "hi [compact:fail:usage]");
    await until(() => ended(events) === 1);
    await h.compact("s1");
    await until(() => ended(events) === 2);
    expect(events.at(-1)).toMatchObject({
      type: "turn.failed",
      error: { kind: "usage_limit", message: "Scripted usage limit" },
    });
    await send(h, "go");
    await until(() => ended(events) === 3);
    expect(kinds(events)).toEqual(["work", "compact", "work"]);
  });

  it("refuses to steer a compaction, with a clear message", async () => {
    const { h, events } = await startHost();
    await send(h, "hi");
    await until(() => ended(events) === 1);
    await h.compact("s1");
    const steer = () =>
      h.steer({ name: "session.steer", sessionId: "s1", input: { text: "and", attachments: [] } });
    const refused = await steer().catch((error: unknown) => error);
    expect(refused).toBeInstanceOf(CommandError);
    expect(refused).toMatchObject({ code: "compacting" });
    expect((refused as Error).message).toMatch(/being compacted.*goes once the compaction ends/);
    await until(() => ended(events) === 2);
    // Nothing reached the compaction turn (the one message is "hi"), and once it is over
    // steering is the provider's call again.
    const messages = events.filter(
      (e) => e.type === "item.completed" && e.item.kind === "user_message",
    );
    expect(messages).toHaveLength(1);
    await expect(steer()).rejects.toMatchObject({ code: "no_turn" });
  });
});
