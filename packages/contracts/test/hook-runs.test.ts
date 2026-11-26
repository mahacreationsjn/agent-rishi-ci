import { describe, expect, it } from "vitest";
import {
  AgentEvent,
  HOOK_OUTPUT_MAX_CHARS,
  HookRunOutcome,
  Item,
  ProviderCapabilities,
  searchableText,
  trimHookOutput,
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

const STATUS: Record<HookRunOutcome, string> = {
  running: "in_progress",
  succeeded: "completed",
  failed: "failed",
  blocked: "declined",
  cancelled: "cancelled",
};

describe("hook_run items", () => {
  it("round-trips every outcome, with and without the optional fields", () => {
    for (const outcome of HookRunOutcome.options) {
      const bare = {
        id: `hook-${outcome}`,
        kind: "hook_run",
        status: STATUS[outcome],
        event: "PreToolUse",
        label: "PreToolUse:Bash",
        outcome,
      };
      expect(roundTrip(Item, bare)).toEqual(bare);
      const full = {
        ...bare,
        source: "/home/me/.claude/settings.json",
        exitCode: outcome === "blocked" ? 2 : null,
        durationMs: 120,
        output: "rm -rf is not allowed",
        outputTruncated: false,
      };
      expect(roundTrip(Item, full)).toEqual(full);
    }
  });

  it("travels in item events and rejects what it can't show", () => {
    const item = {
      id: "h1",
      kind: "hook_run",
      status: "completed",
      event: "Stop",
      label: "command",
      outcome: "succeeded",
    };
    roundTrip(AgentEvent, { type: "item.completed", threadId: "t", turnId: "u", item });
    expect(Item.safeParse({ ...item, event: "" }).success).toBe(false);
    expect(Item.safeParse({ ...item, outcome: "stopped" }).success).toBe(false);
    expect(Item.safeParse({ ...item, durationMs: -1 }).success).toBe(false);
  });

  it("is searchable by its event and label, not its output", () => {
    const text = searchableText({
      id: "h1",
      kind: "hook_run",
      status: "declined",
      event: "PreToolUse",
      label: "guard-shell.sh",
      outcome: "blocked",
      output: "secret-ish output",
    });
    expect(text).toBe("PreToolUse hook\nguard-shell.sh");
  });
});

describe("hookRuns capability", () => {
  it("is optional (absent counts as false)", () => {
    expect(ProviderCapabilities.parse(capabilities).hookRuns).toBeUndefined();
    expect(roundTrip(ProviderCapabilities, { ...capabilities, hookRuns: true }).hookRuns).toBe(
      true,
    );
  });
});

describe("trimHookOutput", () => {
  it("leaves output up to the cap alone, trimming surrounding blank space", () => {
    expect(trimHookOutput("  ok\n")).toEqual({ output: "ok", outputTruncated: false });
    const full = "x".repeat(HOOK_OUTPUT_MAX_CHARS);
    expect(trimHookOutput(full)).toEqual({ output: full, outputTruncated: false });
  });

  it("cuts longer output to the cap, keeping the start and the end", () => {
    const text = `START${"m".repeat(10_000)}END`;
    const { output, outputTruncated } = trimHookOutput(text);
    expect(outputTruncated).toBe(true);
    expect(output.length).toBeLessThanOrEqual(HOOK_OUTPUT_MAX_CHARS);
    expect(output.startsWith("START")).toBe(true);
    expect(output.endsWith("END")).toBe(true);
    const cut = Number(/… ([\d,]+) characters cut …/.exec(output)?.[1]?.replaceAll(",", ""));
    expect(cut).toBeGreaterThan(0);
    // What is kept plus what was cut is the whole text.
    const marker = /\n… [\d,]+ characters cut …\n/.exec(output)?.[0] ?? "";
    expect(output.length - marker.length + cut).toBe(text.length);
  });

  it("never splits a surrogate pair", () => {
    const text = "😀".repeat(5_000);
    const { output } = trimHookOutput(text, 101);
    expect(output.length).toBeLessThanOrEqual(101);
    expect(output).not.toMatch(/[\ud800-\udbff](?![\udc00-\udfff])/);
    expect(output).not.toMatch(/(^|[^\ud800-\udbff])[\udc00-\udfff]/);
  });
});
