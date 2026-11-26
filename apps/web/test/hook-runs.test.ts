import type { AgentEvent, HookRunOutcome, Item, ItemOf } from "@agent-rishi/contracts";
import { describe, expect, it } from "vitest";
import { applyAgentEvent, emptyTranscript } from "@/lib/transcript/reducer";
import {
  buildTimeline,
  rowIndexOfItem,
  summarizeWork,
  type WorkStep,
  workSegments,
} from "@/lib/transcript/timeline";

const T = "t1";
const U = "u1";

const STATUS: Record<HookRunOutcome, ItemOf<"hook_run">["status"]> = {
  running: "in_progress",
  succeeded: "completed",
  failed: "failed",
  blocked: "declined",
  cancelled: "cancelled",
};

const hook = (id: string, outcome: HookRunOutcome = "succeeded"): ItemOf<"hook_run"> => ({
  id,
  kind: "hook_run",
  status: STATUS[outcome],
  event: "PreToolUse",
  label: "Bash",
  outcome,
});

const cmd = (id: string): Item => ({
  id,
  kind: "tool_call",
  toolKind: "command",
  status: "completed",
  toolName: "Bash",
  command: "ls",
});

function timeline(items: Item[]) {
  const events: AgentEvent[] = [
    { type: "thread.started", thread: { id: T } },
    { type: "turn.started", threadId: T, turnId: U },
    ...items.map((item): AgentEvent => ({ type: "item.completed", threadId: T, turnId: U, item })),
    { type: "turn.completed", threadId: T, turnId: U },
  ];
  const state = events.reduce(
    (s, e, i) => applyAgentEvent(s, e, { seq: i + 1, ts: "2026-11-16T10:00:00.000Z" }),
    emptyTranscript("s1"),
  );
  return buildTimeline(state, T);
}

describe("hook runs in the timeline", () => {
  it("keeps succeeded runs between tool calls inside one work group", () => {
    const rows = timeline([hook("h1"), cmd("c1"), hook("h2"), hook("h3"), cmd("c2"), hook("h4")]);
    const work = rows.filter((r) => r.type === "work");
    expect(work).toHaveLength(1);
    expect(work[0]?.type === "work" && work[0].entries.map((e) => e.id)).toEqual([
      "h1",
      "c1",
      "h2",
      "h3",
      "c2",
      "h4",
    ]);
  });

  it("gives a failed or blocked run a row of its own", () => {
    const rows = timeline([cmd("c1"), hook("h1", "blocked"), cmd("c2"), hook("h2", "failed")]);
    expect(rows.map((r) => r.type)).toEqual(["work", "hook", "work", "hook", "turn-end"]);
    expect(rowIndexOfItem(rows, "h1")).toBe(1);
    expect(rowIndexOfItem(rows, "h2")).toBe(3);
  });

  it("collapses consecutive succeeded runs into one segment", () => {
    const steps = [
      hook("a"),
      hook("b"),
      hook("c"),
      cmd("c1"),
      hook("d"),
      hook("e", "running"),
      hook("f"),
      hook("g", "cancelled"),
    ] as WorkStep[];
    expect(
      workSegments(steps).map((s) =>
        s.type === "hooks" ? `hooks:${s.runs.map((r) => r.id).join("")}` : s.step.id,
      ),
    ).toEqual(["hooks:abc", "c1", "d", "e", "f", "g"]);
  });

  it("names a group by its work, or by its hooks when it has nothing else", () => {
    expect(summarizeWork([hook("a"), hook("b"), hook("c")])).toBe("3 hooks ran");
    expect(summarizeWork([hook("a")])).toBe("1 hook ran");
    expect(summarizeWork([hook("a"), cmd("c1") as WorkStep, hook("b")])).toBe("Ran 1 command");
  });
});
