import { describe, expect, it } from "vitest";
import {
  AgentEvent,
  CompactSessionResponse,
  ProviderCapabilities,
  RunnerCommand,
  RunnerCommandResults,
  Turn,
  TurnKind,
} from "../src";

function roundTrip<T>(schema: { parse: (v: unknown) => T }, value: unknown): T {
  const first = schema.parse(value);
  const second = schema.parse(JSON.parse(JSON.stringify(first)));
  expect(second).toEqual(first);
  return second;
}

const capabilities = {
  resume: true,
  steer: false,
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
};

describe("compaction contracts", () => {
  it("keeps compact optional on capabilities (absent counts as false)", () => {
    expect(ProviderCapabilities.parse(capabilities).compact).toBeUndefined();
    expect(roundTrip(ProviderCapabilities, { ...capabilities, compact: true }).compact).toBe(true);
  });

  it("round-trips the runner's session.compact and its result", () => {
    expect(roundTrip(RunnerCommand, { name: "session.compact", sessionId: "s1" })).toEqual({
      name: "session.compact",
      sessionId: "s1",
    });
    expect(RunnerCommand.safeParse({ name: "session.compact" }).success).toBe(false);
    roundTrip(RunnerCommandResults["session.compact"], {});
  });

  it("marks compaction turns on turn.started and the turn (absent counts as work)", () => {
    const started = { type: "turn.started", threadId: "t1", turnId: "u1" };
    expect(roundTrip(AgentEvent, started)).toEqual(started);
    expect(roundTrip(AgentEvent, { ...started, kind: "compact" })).toMatchObject({
      kind: "compact",
    });
    expect(AgentEvent.safeParse({ ...started, kind: "review" }).success).toBe(false);
    const turn = {
      id: "u1",
      threadId: "t1",
      sessionId: "s1",
      status: "failed",
      startedAt: "2026-11-15T10:00:00.000Z",
      completedAt: "2026-11-15T10:00:05.000Z",
      error: { message: "Usage limit", kind: "usage_limit" },
    };
    expect(roundTrip(Turn, turn).kind).toBeUndefined();
    expect(roundTrip(Turn, { ...turn, kind: null }).kind).toBeNull();
    expect(roundTrip(Turn, { ...turn, kind: "compact" }).kind).toBe("compact");
    expect(TurnKind.options).toEqual(["work", "compact"]);
  });

  it("round-trips the API response", () => {
    expect(roundTrip(CompactSessionResponse, { status: "compacting" })).toEqual({
      status: "compacting",
    });
    expect(CompactSessionResponse.safeParse({ status: "sent" }).success).toBe(false);
  });
});
