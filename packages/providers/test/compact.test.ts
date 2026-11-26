import { AgentEvent, type SessionOptions } from "@agent-rishi/contracts";
import { describe, expect, it } from "vitest";
import { ClaudeEventMapper } from "../src/claude/mapper";
import { startedItem } from "../src/codex/items";
import { TurnStartWatch } from "../src/codex/turn-start-watch";
import { FAKE_COMPACTED_CONTEXT_TOKENS } from "../src/fake/compact";
import { FakeSession } from "../src/fake/session";
import { OpenCodeEventMapper } from "../src/opencode/mapper";
import type { OcEvent } from "../src/opencode/protocol";

const notices = (events: AgentEvent[]) =>
  events.flatMap((e) =>
    e.type === "item.completed" && e.item.kind === "notice"
      ? [{ id: e.item.id, code: e.item.code, message: e.item.message }]
      : [],
  );

describe("Compact now, per provider", () => {
  it("Claude: a compaction turn shows its notice at once and takes the context it leaves", () => {
    const events: AgentEvent[] = [];
    let n = 0;
    const mapper = new ClaudeEventMapper({
      sessionId: "s1",
      cwd: "/work/repo",
      emit: (e) => events.push(AgentEvent.parse(e)),
      newId: () => `id${++n}`,
    });
    mapper.start();
    const turnId = mapper.beginCompaction();
    expect(events.some((e) => e.type === "turn.started" && e.turnId === turnId)).toBe(true);
    // The CLI's own status doesn't add a second notice.
    mapper.handle({ type: "system", subtype: "status", status: "compacting" });
    mapper.handle({
      type: "system",
      subtype: "compact_boundary",
      compact_metadata: { trigger: "manual", pre_tokens: 150_000, post_tokens: 12_000 },
    });
    mapper.handle({ type: "result", subtype: "success", is_error: false, usage: {} });
    const [compacting, compacted] = notices(events);
    expect(compacting).toMatchObject({ code: "compacting" });
    expect(compacted).toMatchObject({ id: compacting?.id, code: "context_compacted" });
    expect(notices(events)).toHaveLength(2);
    const usage = events.findLast((e) => e.type === "usage.updated");
    expect(usage?.type === "usage.updated" && usage.usage.contextTokens).toBe(12_000);
    expect(events.at(-1)).toMatchObject({ type: "turn.completed", turnId });
    expect(events.some((e) => e.type === "item.completed" && e.item.kind === "user_message")).toBe(
      false,
    );
  });

  it("Codex: a running compaction says so, and its completion replaces the notice", () => {
    const item = { type: "contextCompaction", id: "cc-1" } as Parameters<typeof startedItem>[0];
    expect(startedItem(item)).toMatchObject({ id: "cc-1", kind: "notice", code: "compacting" });
  });

  it("Codex: waits for the turn the compaction starts, counting one that came first", async () => {
    const watch = new TurnStartWatch();
    const before = watch.count;
    const waiting = watch.startedSince(before, 60_000);
    watch.note();
    expect(await waiting).toBe(true);
    // The turn started before the request's answer arrived.
    expect(await watch.startedSince(before, 0)).toBe(true);
    // No turn in time: the session is free again.
    expect(await watch.startedSince(watch.count, 1)).toBe(false);
  });

  it("OpenCode: one notice per compaction, replaced by its outcome", () => {
    const events: AgentEvent[] = [];
    const m = new OpenCodeEventMapper({
      sessionId: "s1",
      emit: (e) => events.push(e),
      tools: { cwd: "/repo", mcpServers: [] },
    });
    m.rootSession = "ses_1";
    m.pendingTurnId = "turn-c";
    const run: OcEvent[] = [
      { type: "session.execution.started", data: { sessionID: "ses_1" } },
      {
        type: "session.compaction.started",
        data: { sessionID: "ses_1", reason: "manual", inputID: "msg_1" },
      },
      {
        type: "session.compaction.ended",
        data: { sessionID: "ses_1", reason: "manual", inputID: "msg_1" },
      },
      { type: "session.execution.succeeded", data: { sessionID: "ses_1" } },
    ];
    for (const event of run) m.handle(event);
    const [compacting, compacted] = notices(events);
    expect(compacting).toMatchObject({ id: "compaction-msg_1", code: "compacting" });
    expect(compacted).toMatchObject({ id: "compaction-msg_1", code: "context_compacted" });
    expect(events.at(-1)).toMatchObject({ type: "turn.completed", turnId: "turn-c" });
  });

  it("Fake: compacts as a turn of its own, and refuses while a turn runs", async () => {
    const session = new FakeSession(
      { sessionId: "s1", role: "agent", cwd: "/repo", autonomy: "auto" } as SessionOptions,
      { followups: false },
    );
    await session.compact();
    await expect(session.compact()).rejects.toMatchObject({ code: "turn_running" });
    const events: AgentEvent[] = [];
    for await (const event of session.events) {
      events.push(event);
      if (event.type === "turn.completed") break;
    }
    expect(notices(events).map((x) => x.code)).toEqual(["compacting", "context_compacted"]);
    const usage = events.find((e) => e.type === "usage.updated");
    expect(usage?.type === "usage.updated" && usage.usage.contextTokens).toBe(
      FAKE_COMPACTED_CONTEXT_TOKENS,
    );
    await session.close();
  });
});
