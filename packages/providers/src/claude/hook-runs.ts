import {
  HOOK_RUN_STATUS,
  type HookRunOutcome,
  type Item,
  type ItemOf,
  trimHookOutput,
} from "@agent-rishi/contracts";
import { str } from "../util/text";
import type { ThreadCtx } from "./subagents";

type Raw = Record<string, unknown>;
type HookRun = ItemOf<"hook_run">;
type Phase = "item.started" | "item.updated" | "item.completed";

/** Least time between two live updates of one run's output, so the log gets no event per chunk. */
export const HOOK_PROGRESS_INTERVAL_MS = 5_000;
/** Most finished runs kept while no turn runs (SessionStart hooks as the process starts). */
const MAX_HELD = 20;
/** Most runs tracked at once; a run that never reports back is dropped after this many more. */
const MAX_OPEN = 100;

interface Run {
  item: HookRun;
  startedAt: number;
  /** When the item was last sent: its start or its latest live update. */
  sentAt: number;
  /** The turn the run is shown in; absent while it waits for one. */
  ctx?: ThreadCtx;
}

export interface ClaudeHookRunsOptions {
  /** The running root turn, or undefined between turns. Never starts one. */
  turn: () => ThreadCtx | undefined;
  item: (ctx: ThreadCtx, phase: Phase, item: Item) => void;
  now: () => number;
}

/**
 * The hooks from the user's settings that ran, as `hook_run` items (§12.4), from the SDK's
 * `hook_started`, `hook_progress` and `hook_response` messages (`includeHookEvents`). Claude Code
 * reports command, HTTP and MCP tool hooks; never the SDK's in-process callbacks, so Agent Rishi's
 * own approvals hook can't appear. A response whose start wasn't seen is ignored for the same
 * reason. Runs outside a turn (SessionStart as the process starts) wait for the next turn rather
 * than starting one.
 */
export class ClaudeHookRuns {
  private readonly runs = new Map<string, Run>();
  /** Runs that finished while no turn ran, shown when the next one begins. */
  private held: HookRun[] = [];

  constructor(private readonly o: ClaudeHookRunsOptions) {}

  /** Feed a `system` message; true when it was a hook message. */
  handle(msg: Raw): boolean {
    switch (msg.subtype) {
      case "hook_started":
        this.onStarted(msg);
        return true;
      case "hook_progress":
        this.onProgress(msg);
        return true;
      case "hook_response":
        this.onResponse(msg);
        return true;
      default:
        return false;
    }
  }

  /** A root turn began: show the runs that waited for one. */
  turnStarted(ctx: ThreadCtx): void {
    for (const item of this.held) this.o.item(ctx, "item.completed", item);
    this.held = [];
    for (const run of this.runs.values()) {
      if (run.ctx) continue;
      run.ctx = ctx;
      this.o.item(ctx, "item.started", run.item);
    }
  }

  /**
   * A root turn ended. Runs still going in a turn that didn't complete end as cancelled; in a
   * completed turn they stay open (a hook's response can come after the turn's result).
   */
  turnEnded(turnId: string, completed: boolean): void {
    if (completed) return;
    for (const [id, run] of this.runs) {
      if (run.ctx?.turnId !== turnId) continue;
      this.runs.delete(id);
      this.o.item(run.ctx, "item.completed", this.finish(run, "cancelled"));
    }
  }

  /** The session is closing: every run still going ends as cancelled. */
  closeAll(): void {
    for (const run of this.runs.values()) {
      if (run.ctx) this.o.item(run.ctx, "item.completed", this.finish(run, "cancelled"));
    }
    this.runs.clear();
    this.held = [];
  }

  private onStarted(msg: Raw): void {
    const hookId = str(msg, "hook_id");
    const event = str(msg, "hook_event");
    if (!hookId || !event || this.runs.has(hookId)) return;
    if (this.runs.size >= MAX_OPEN) this.runs.delete(this.runs.keys().next().value as string);
    const now = this.o.now();
    const item: HookRun = {
      id: `hook-${hookId}`,
      kind: "hook_run",
      status: "in_progress",
      event,
      label: hookLabel(str(msg, "hook_name"), event),
      outcome: "running",
    };
    const ctx = this.o.turn();
    this.runs.set(hookId, { item, startedAt: now, sentAt: now, ...(ctx ? { ctx } : {}) });
    if (ctx) this.o.item(ctx, "item.started", item);
  }

  private onProgress(msg: Raw): void {
    const run = this.runs.get(str(msg, "hook_id") ?? "");
    if (!run) return;
    const text = pickOutput("running", msg);
    if (!text) return;
    const trimmed = trimHookOutput(text);
    run.item = { ...run.item, ...trimmed };
    const now = this.o.now();
    if (!run.ctx || now - run.sentAt < HOOK_PROGRESS_INTERVAL_MS) return;
    run.sentAt = now;
    this.o.item(run.ctx, "item.updated", run.item);
  }

  private onResponse(msg: Raw): void {
    const hookId = str(msg, "hook_id") ?? "";
    const run = this.runs.get(hookId);
    if (!run) return;
    this.runs.delete(hookId);
    const exitCode = typeof msg.exit_code === "number" ? msg.exit_code : undefined;
    const outcome = responseOutcome(str(msg, "outcome"), exitCode, str(msg, "stdout"));
    const done = this.finish(run, outcome, pickOutput(outcome, msg), exitCode);
    const ctx = run.ctx ?? this.o.turn();
    if (ctx) {
      this.o.item(ctx, "item.completed", done);
      return;
    }
    if (this.held.length >= MAX_HELD) this.held.shift();
    this.held.push(done);
  }

  /** The run's final item; without final output, what it printed while it ran stays. */
  private finish(run: Run, outcome: HookRunOutcome, output?: string, exitCode?: number): HookRun {
    const { output: live, outputTruncated: liveCut, ...rest } = run.item;
    const trimmed = output
      ? trimHookOutput(output)
      : live
        ? { output: live, outputTruncated: liveCut ?? false }
        : undefined;
    return {
      ...rest,
      status: HOOK_RUN_STATUS[outcome],
      outcome,
      ...(exitCode !== undefined ? { exitCode } : {}),
      durationMs: Math.max(0, Math.round(this.o.now() - run.startedAt)),
      ...(trimmed?.output ? trimmed : {}),
    };
  }
}

/**
 * What the run is called: Claude Code names a hook `<event>:<tool>` (the tool a PreToolUse or
 * PostToolUse hook ran for) or just `<event>`, so the event part, shown anyway, is dropped.
 */
export function hookLabel(name: string | undefined, event: string): string {
  if (!name || name === event) return "";
  return name.startsWith(`${event}:`) ? name.slice(event.length + 1) : name;
}

/**
 * How a finished run ended. Exit code 2 is Claude Code's blocking error; a hook that exits 0 can
 * also block with JSON on stdout (`decision: "block"`, `continue: false`, or a `deny`).
 */
export function responseOutcome(
  outcome: string | undefined,
  exitCode: number | undefined,
  stdout: string | undefined,
): HookRunOutcome {
  if (outcome === "cancelled") return "cancelled";
  if (outcome === "error") return exitCode === 2 ? "blocked" : "failed";
  return blocksByJson(stdout) ? "blocked" : "succeeded";
}

function blocksByJson(stdout: string | undefined): boolean {
  const text = stdout?.trim();
  if (!text?.startsWith("{")) return false;
  try {
    const json = JSON.parse(text) as Raw;
    const specific = (json.hookSpecificOutput ?? {}) as Raw;
    return (
      json.decision === "block" || json.continue === false || specific.permissionDecision === "deny"
    );
  } catch {
    return false;
  }
}

/** The text to keep: the reason (stderr first) for a blocked or failed run, else what it printed. */
function pickOutput(outcome: HookRunOutcome, msg: Raw): string {
  const stdout = str(msg, "stdout")?.trim() ?? "";
  const stderr = str(msg, "stderr")?.trim() ?? "";
  const output = str(msg, "output")?.trim() ?? "";
  const order =
    outcome === "blocked" || outcome === "failed"
      ? [stderr, output, stdout]
      : [stdout, output, stderr];
  return order.find(Boolean) ?? "";
}
