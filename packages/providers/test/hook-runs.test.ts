import { tmpdir } from "node:os";
import { AgentEvent, type ItemOf, type SessionOptions } from "@agent-rishi/contracts";
import { describe, expect, it } from "vitest";
import { FakeProvider, getProvider } from "../src";
import { HOOK_PROGRESS_INTERVAL_MS } from "../src/claude/hook-runs";
import { ClaudeEventMapper } from "../src/claude/mapper";
import { buildQueryOptions } from "../src/claude/options";
import { CodexEventMapper } from "../src/codex/mapper";
import type { ServerNotification } from "../src/codex/protocol";

type HookRun = ItemOf<"hook_run">;

const hookEvents = (events: AgentEvent[]) =>
  events.flatMap((e) =>
    "item" in e && e.item.kind === "hook_run" ? [{ ...e, item: e.item as HookRun }] : [],
  );

describe("hookRuns capability", () => {
  it("is on for Claude and Codex and absent for the providers that report no runs", () => {
    expect(getProvider("claude")?.capabilities().hookRuns).toBe(true);
    expect(getProvider("codex")?.capabilities().hookRuns).toBe(true);
    for (const id of ["opencode", "cursor", "gemini"]) {
      expect(getProvider(id)?.capabilities().hookRuns).toBeUndefined();
    }
    expect(new FakeProvider().capabilities().hookRuns).toBeUndefined();
  });

  it("turns on Claude's hook events for every session", () => {
    const session: SessionOptions = {
      sessionId: "s1",
      role: "agent",
      cwd: tmpdir(),
      autonomy: "auto",
      mcpServers: [],
      additionalDirectories: [],
      planMode: false,
    };
    const options = buildQueryOptions({
      session,
      executable: { kind: "native", path: "/bin/claude" } as never,
      canUseTool: async () => ({ behavior: "allow", updatedInput: {} }),
      hooks: {},
      abortController: new AbortController(),
    });
    expect(options.includeHookEvents).toBe(true);
  });
});

describe("Claude hook runs", () => {
  function setup() {
    let clock = 10_000;
    const events: AgentEvent[] = [];
    let n = 0;
    const mapper = new ClaudeEventMapper({
      sessionId: "s1",
      cwd: "/work/repo",
      emit: (e) => events.push(AgentEvent.parse(e)),
      newId: () => `id${++n}`,
      now: () => clock,
    });
    mapper.start();
    const tick = (ms: number) => {
      clock += ms;
    };
    return { mapper, events, tick };
  }

  const started = (id: string, event = "PreToolUse", name = `${event}:Bash`) => ({
    type: "system",
    subtype: "hook_started",
    hook_id: id,
    hook_name: name,
    hook_event: event,
  });
  const progress = (id: string, stdout: string) => ({
    type: "system",
    subtype: "hook_progress",
    hook_id: id,
    hook_name: "PreToolUse:Bash",
    hook_event: "PreToolUse",
    stdout,
    stderr: "",
    output: stdout,
  });
  const response = (id: string, fields: object) => ({
    type: "system",
    subtype: "hook_response",
    hook_id: id,
    hook_name: "PreToolUse:Bash",
    hook_event: "PreToolUse",
    stdout: "",
    stderr: "",
    output: "",
    ...fields,
  });

  it("starts a running item and completes it with the outcome, output and duration", () => {
    const { mapper, events, tick } = setup();
    const turnId = mapper.beginTurn();
    mapper.handle(started("h1", "PostToolUse", "PostToolUse:Edit"));
    tick(250);
    mapper.handle(
      response("h1", { outcome: "success", exit_code: 0, stdout: "formatted 2 files\n" }),
    );
    const [start, done] = hookEvents(events);
    expect(start).toMatchObject({
      type: "item.started",
      threadId: "s1:thread-root",
      turnId,
      item: {
        id: "hook-h1",
        status: "in_progress",
        event: "PostToolUse",
        label: "Edit",
        outcome: "running",
      },
    });
    expect(done).toMatchObject({
      type: "item.completed",
      turnId,
      item: {
        id: "hook-h1",
        status: "completed",
        outcome: "succeeded",
        exitCode: 0,
        durationMs: 250,
        output: "formatted 2 files",
        outputTruncated: false,
      },
    });
  });

  it("maps each response outcome", () => {
    const { mapper, events } = setup();
    mapper.beginTurn();
    const cases: Array<[object, string, string, string | undefined]> = [
      [
        { outcome: "error", exit_code: 2, stderr: "rm -rf is not allowed", stdout: "x" },
        "blocked",
        "declined",
        "rm -rf is not allowed",
      ],
      [
        { outcome: "error", exit_code: 1, stderr: "prettier: not found" },
        "failed",
        "failed",
        "prettier: not found",
      ],
      [{ outcome: "cancelled" }, "cancelled", "cancelled", undefined],
      [
        { outcome: "success", exit_code: 0, stdout: '{"decision":"block","reason":"tests fail"}' },
        "blocked",
        "declined",
        '{"decision":"block","reason":"tests fail"}',
      ],
      [
        {
          outcome: "success",
          exit_code: 0,
          stdout:
            '{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny"}}',
        },
        "blocked",
        "declined",
        undefined,
      ],
      [
        { outcome: "success", exit_code: 0, stdout: '{"continue":false}' },
        "blocked",
        "declined",
        undefined,
      ],
      [
        { outcome: "success", exit_code: 0, stdout: '{"decision":"approve"}' },
        "succeeded",
        "completed",
        undefined,
      ],
    ];
    cases.forEach(([fields], i) => {
      mapper.handle(started(`c${i}`));
      mapper.handle(response(`c${i}`, fields));
    });
    const done = hookEvents(events).filter((e) => e.type === "item.completed");
    expect(done.map((e) => [e.item.outcome, e.item.status])).toEqual(
      cases.map(([, outcome, status]) => [outcome, status]),
    );
    cases.forEach(([, , , output], i) => {
      if (output !== undefined) expect(done[i]?.item.output).toBe(output);
    });
    expect(done[0]?.item.exitCode).toBe(2);
  });

  it("keeps progress on the run without an event per chunk", () => {
    const { mapper, events, tick } = setup();
    mapper.beginTurn();
    mapper.handle(started("p1", "Stop", "Stop"));
    tick(1_000);
    mapper.handle(progress("p1", "running checks"));
    tick(1_000);
    mapper.handle(progress("p1", "running checks\nlint ok"));
    expect(hookEvents(events).map((e) => e.type)).toEqual(["item.started"]);
    // A long hook's output reaches the live item now and then.
    tick(HOOK_PROGRESS_INTERVAL_MS);
    mapper.handle(progress("p1", "running checks\nlint ok\ntests ok"));
    const updated = hookEvents(events).at(-1);
    expect(updated).toMatchObject({
      type: "item.updated",
      item: { outcome: "running", output: "running checks\nlint ok\ntests ok", label: "" },
    });
    // A response without output keeps what it printed.
    mapper.handle(response("p1", { hook_event: "Stop", outcome: "success", exit_code: 0 }));
    expect(hookEvents(events).at(-1)?.item).toMatchObject({
      outcome: "succeeded",
      output: "running checks\nlint ok\ntests ok",
    });
  });

  it("ignores a response whose start it never saw", () => {
    const { mapper, events } = setup();
    mapper.beginTurn();
    mapper.handle(response("ghost", { outcome: "success", exit_code: 0, stdout: "hi" }));
    mapper.handle(progress("ghost", "hi"));
    expect(hookEvents(events)).toEqual([]);
  });

  it("holds runs from before any turn for the next one instead of starting a turn", () => {
    const { mapper, events } = setup();
    mapper.handle(started("s1", "SessionStart", "SessionStart:startup"));
    mapper.handle(
      response("s1", {
        hook_event: "SessionStart",
        outcome: "success",
        exit_code: 0,
        stdout: "loaded context",
      }),
    );
    mapper.handle(started("s2", "SessionStart", "SessionStart:startup"));
    expect(events.some((e) => e.type === "turn.started")).toBe(false);
    expect(hookEvents(events)).toEqual([]);

    const turnId = mapper.beginTurn();
    const shown = hookEvents(events);
    expect(shown.map((e) => [e.type, e.item.id, e.turnId])).toEqual([
      ["item.completed", "hook-s1", turnId],
      ["item.started", "hook-s2", turnId],
    ]);
    expect(shown[0]?.item).toMatchObject({ event: "SessionStart", label: "startup" });
  });

  it("cancels runs still going when the turn is interrupted, and only then", () => {
    const { mapper, events } = setup();
    const first = mapper.beginTurn();
    mapper.handle(started("a1", "PostToolUse"));
    mapper.endTurn({ type: "completed" });
    // A completed turn leaves it open: the response can come after the result.
    expect(hookEvents(events).map((e) => e.type)).toEqual(["item.started"]);
    mapper.handle(response("a1", { outcome: "success", exit_code: 0 }));
    expect(hookEvents(events).at(-1)).toMatchObject({
      type: "item.completed",
      turnId: first,
      item: { outcome: "succeeded" },
    });

    mapper.beginTurn();
    mapper.handle(started("b1"));
    mapper.endTurn({ type: "interrupted", reason: "user" });
    expect(hookEvents(events).at(-1)?.item).toMatchObject({
      id: "hook-b1",
      outcome: "cancelled",
      status: "cancelled",
    });
  });
});

describe("Codex hook runs", () => {
  const ROOT = "codex-root";
  const CHILD = "codex-child";

  function setup() {
    const events: AgentEvent[] = [];
    const mapper = new CodexEventMapper("s1", (e) => events.push(AgentEvent.parse(e)));
    mapper.codexThreadId = ROOT;
    const feed = (method: string, params: object, threadId = ROOT) =>
      mapper.handle({ method, params: { threadId, ...params } } as unknown as ServerNotification);
    return { mapper, events, feed };
  }

  const turn = (id: string) => ({
    id,
    items: [],
    itemsView: "summary",
    status: "inProgress",
    error: null,
    startedAt: 1,
    completedAt: null,
    durationMs: null,
  });

  const run = (id: string, fields: object = {}) => ({
    id,
    eventName: "preToolUse",
    handlerType: "command",
    executionMode: "sync",
    scope: "turn",
    sourcePath: "/home/me/.codex/hooks.json",
    source: "user",
    displayOrder: 0,
    status: "running",
    statusMessage: null,
    startedAt: 1,
    completedAt: null,
    durationMs: null,
    entries: [],
    ...fields,
  });

  it("maps hook/started and hook/completed to one hook_run item", () => {
    const { events, feed } = setup();
    feed("turn/started", { turn: turn("t1") });
    feed("hook/started", { turnId: "t1", run: run("r1") });
    feed("hook/completed", {
      turnId: "t1",
      run: run("r1", {
        status: "blocked",
        statusMessage: "Blocked a risky command",
        completedAt: 2,
        durationMs: 42,
        entries: [
          { kind: "feedback", text: "rm -rf / is not allowed" },
          { kind: "context", text: "see SECURITY.md" },
        ],
      }),
    });
    const [start, done] = hookEvents(events);
    expect(start).toMatchObject({
      type: "item.started",
      threadId: "s1:thread-root",
      turnId: "t1",
      item: { event: "PreToolUse", label: "command", outcome: "running" },
    });
    expect(done).toMatchObject({
      type: "item.completed",
      turnId: "t1",
      item: {
        id: start?.item.id,
        status: "declined",
        event: "PreToolUse",
        source: "/home/me/.codex/hooks.json",
        outcome: "blocked",
        durationMs: 42,
        output:
          "Blocked a risky command\nfeedback: rm -rf / is not allowed\ncontext: see SECURITY.md",
      },
    });
    expect(start?.item.id).toMatch(/^hook-/);
    expect(done?.item.exitCode).toBeUndefined();
  });

  it("maps each run status", () => {
    const { events, feed } = setup();
    feed("turn/started", { turn: turn("t1") });
    const statuses = ["completed", "failed", "blocked", "stopped"];
    statuses.forEach((status, i) => {
      feed("hook/completed", {
        turnId: "t1",
        run: run(`r${i}`, { status, eventName: "userPromptSubmit", handlerType: "mcpTool" }),
      });
    });
    expect(hookEvents(events).map((e) => [e.item.outcome, e.item.event, e.item.label])).toEqual([
      ["succeeded", "UserPromptSubmit", "MCP tool"],
      ["failed", "UserPromptSubmit", "MCP tool"],
      ["blocked", "UserPromptSubmit", "MCP tool"],
      ["blocked", "UserPromptSubmit", "MCP tool"],
    ]);
  });

  it("holds thread-scoped runs for the next turn and cancels runs of an interrupted turn", () => {
    const { mapper, events, feed } = setup();
    feed("hook/completed", {
      turnId: null,
      run: run("start", { eventName: "sessionStart", scope: "thread", status: "completed" }),
    });
    expect(events.some((e) => e.type === "turn.started")).toBe(false);
    feed("turn/started", { turn: turn("t1") });
    expect(hookEvents(events)[0]).toMatchObject({
      type: "item.completed",
      turnId: "t1",
      item: { event: "SessionStart", outcome: "succeeded" },
    });

    feed("hook/started", { turnId: "t1", run: run("slow") });
    const slow = hookEvents(events).at(-1)?.item.id;
    mapper.endTurn({ type: "interrupted" });
    expect(hookEvents(events).at(-1)).toMatchObject({
      type: "item.completed",
      turnId: "t1",
      item: { id: slow, outcome: "cancelled", status: "cancelled" },
    });
  });

  it("shows a sub-agent's hook runs in its child thread", () => {
    const { events, feed } = setup();
    feed("turn/started", { turn: turn("rt") });
    feed("item/completed", {
      turnId: "rt",
      item: {
        type: "subAgentActivity",
        id: "call-spawn",
        kind: "started",
        agentThreadId: CHILD,
        agentPath: "/root/explorer",
      },
    });
    feed("turn/started", { turn: turn("ct") }, CHILD);
    feed("hook/completed", { turnId: "ct", run: run("child-run", { status: "completed" }) }, CHILD);
    const runs = hookEvents(events);
    expect(runs).toHaveLength(1);
    expect(runs[0]?.threadId).toBe("s1:thread-call-spawn");
    expect(runs[0]?.turnId).toBe("ct");
  });

  // Codex's `run.id` names the handler, not the run: `<event>:<displayOrder>:<hooks file>`, the
  // same for every run of it (seen from `codex app-server` 0.160.1).
  describe("with Codex's real run ids (one per handler)", () => {
    const HANDLER = "pre-tool-use:0:C:\\Users\\me\\.codex\\hooks.json";
    const pre = (fields: object = {}) => run(HANDLER, fields);
    const done = (fields: object = {}) => pre({ status: "completed", durationMs: 5, ...fields });

    /** Each item id with the threads, turns and phases it was emitted in. */
    const byItem = (events: AgentEvent[]) => {
      const out = new Map<string, string[]>();
      for (const e of hookEvents(events)) {
        const seen = out.get(e.item.id) ?? [];
        seen.push(`${e.threadId}/${e.turnId}/${e.type}/${e.item.outcome}`);
        out.set(e.item.id, seen);
      }
      return [...out.values()];
    };

    it("gives two runs of one handler in one turn an item each, paired in order", () => {
      const { events, feed } = setup();
      feed("turn/started", { turn: turn("t1") });
      // Parallel tool calls: both start before either completes.
      feed("hook/started", { turnId: "t1", run: pre() });
      feed("hook/started", { turnId: "t1", run: pre() });
      feed("hook/completed", { turnId: "t1", run: done({ statusMessage: "first" }) });
      feed("hook/completed", {
        turnId: "t1",
        run: done({ status: "blocked", statusMessage: "second" }),
      });
      const R = "s1:thread-root/t1";
      expect(byItem(events)).toEqual([
        [`${R}/item.started/running`, `${R}/item.completed/succeeded`],
        [`${R}/item.started/running`, `${R}/item.completed/blocked`],
      ]);
      const outputs = hookEvents(events)
        .filter((e) => e.type === "item.completed")
        .map((e) => e.item.output);
      expect(outputs).toEqual(["first", "second"]);
    });

    it("gives runs in later turns items of their own, in their own turns", () => {
      const { events, feed } = setup();
      for (const t of ["t1", "t2"]) {
        feed("turn/started", { turn: turn(t) });
        for (let i = 0; i < 2; i++) {
          feed("hook/started", { turnId: t, run: pre() });
          feed("hook/completed", { turnId: t, run: done() });
        }
        feed("turn/completed", { turn: { ...turn(t), status: "completed" } });
      }
      const items = byItem(events);
      expect(items).toHaveLength(4);
      expect(items.map((seen) => seen.map((s) => s.split("/")[1]))).toEqual([
        ["t1", "t1"],
        ["t1", "t1"],
        ["t2", "t2"],
        ["t2", "t2"],
      ]);
    });

    it("lands a sub-agent's run of the root's handler on its child thread, as a new item", () => {
      const { events, feed } = setup();
      feed("turn/started", { turn: turn("rt") });
      feed("hook/started", { turnId: "rt", run: pre() });
      feed("hook/completed", { turnId: "rt", run: done() });
      feed("item/completed", {
        turnId: "rt",
        item: {
          type: "subAgentActivity",
          id: "call-spawn",
          kind: "started",
          agentThreadId: CHILD,
          agentPath: "/root/explorer",
        },
      });
      feed("turn/started", { turn: turn("ct") }, CHILD);
      feed("hook/started", { turnId: "ct", run: pre() }, CHILD);
      feed("hook/completed", { turnId: "ct", run: done() }, CHILD);
      expect(byItem(events)).toEqual([
        ["s1:thread-root/rt/item.started/running", "s1:thread-root/rt/item.completed/succeeded"],
        [
          "s1:thread-call-spawn/ct/item.started/running",
          "s1:thread-call-spawn/ct/item.completed/succeeded",
        ],
      ]);
    });

    it("gives each completion without a start a fresh item", () => {
      const { events, feed } = setup();
      feed("turn/started", { turn: turn("t1") });
      feed("hook/completed", { turnId: "t1", run: done() });
      feed("hook/completed", { turnId: "t1", run: done() });
      expect(byItem(events)).toHaveLength(2);
    });
  });
});
