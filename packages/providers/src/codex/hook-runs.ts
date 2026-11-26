import { randomUUID } from "node:crypto";
import {
  HOOK_RUN_STATUS,
  type HookRunOutcome,
  type ItemOf,
  trimHookOutput,
} from "@agent-rishi/contracts";
import type { HookHandlerType, HookRunStatus, HookRunSummary } from "./protocol/v2";

type HookRun = ItemOf<"hook_run">;

/** Most runs tracked or held at once; one that never reports back is dropped after this many. */
const MAX_RUNS = 100;

/** `stopped`: the hook halted the agent, which the transcript shows like a block. */
const OUTCOME: Record<HookRunStatus, HookRunOutcome> = {
  running: "running",
  completed: "succeeded",
  failed: "failed",
  blocked: "blocked",
  stopped: "blocked",
};

const HANDLER: Record<HookHandlerType, string> = {
  command: "command",
  mcpTool: "MCP tool",
  prompt: "prompt",
  agent: "agent",
};

/** Codex's camelCase event name in the providers' common PascalCase: `preToolUse` → `PreToolUse`. */
export function codexHookEvent(name: string): string {
  return name.charAt(0).toUpperCase() + name.slice(1);
}

/**
 * A Codex hook run (`hook/started`, `hook/completed`) as a `hook_run` item (§12.4), under the
 * item id `id`. Codex names no command, so the label is the handler type and the source its hooks
 * file; the output is the status message and the entries the hook reported (`warning`, `stop`,
 * `feedback`, `context`, `error`), one per line. `done`: from `hook/completed`, which never leaves
 * a run running.
 */
export function codexHookRun(run: HookRunSummary, done: boolean, id: string): HookRun {
  let outcome = OUTCOME[run.status] ?? "failed";
  if (done && outcome === "running") outcome = "succeeded";
  const lines = [
    run.statusMessage ?? "",
    ...(run.entries ?? []).map((entry) => `${entry.kind}: ${entry.text}`),
  ].filter((line) => line.trim());
  const kept = lines.length > 0 ? trimHookOutput(lines.join("\n")) : undefined;
  const durationMs = Number(run.durationMs);
  return {
    id,
    kind: "hook_run",
    status: HOOK_RUN_STATUS[outcome],
    event: codexHookEvent(run.eventName),
    label: HANDLER[run.handlerType] ?? String(run.handlerType ?? ""),
    ...(run.sourcePath ? { source: run.sourcePath } : {}),
    outcome,
    ...(run.durationMs !== null && Number.isFinite(durationMs) && durationMs >= 0
      ? { durationMs: Math.round(durationMs) }
      : {}),
    ...(kept?.output ? kept : {}),
  };
}

export interface CodexHookRunsOptions {
  /** The thread's running turn, if any. */
  current: () => string | undefined;
  /** Begin a turn a run is reported for, as an item would. */
  beginTurn: (turnId: string) => void;
  emit: (turnId: string, phase: "item.started" | "item.completed", item: HookRun) => void;
  /** Item id suffixes (tests); default random UUIDs. */
  newId?: () => string;
}

/** A run that started and hasn't completed. No `turnId` while it waits for a turn. */
interface OpenRun {
  itemId: string;
  turnId?: string;
  item: HookRun;
}

/**
 * One Codex thread's hook runs, shown in the turn they ran in. Codex's `run.id` names the hook
 * handler (`pre-tool-use:0:<hooks file>`), not one run of it, so every run gets an item id of its
 * own when it starts (unique across the session's threads and processes, as items are keyed by
 * session), and a completion is paired with the open run of the same handler: the one in its turn,
 * else the oldest. A run keeps the turn it started in, so its completion lands there even after
 * that turn ended. Thread-scoped runs (no turn id, such as SessionStart) go to the running turn,
 * or wait for the next one.
 */
export class CodexHookRuns {
  /** Open runs by Codex's `run.id`, oldest first (one handler can run more than once at a time). */
  private readonly open = new Map<string, OpenRun[]>();
  private openCount = 0;
  /** Runs that completed while no turn ran, shown when the next one begins. */
  private held: HookRun[] = [];
  private readonly newId: () => string;

  constructor(private readonly o: CodexHookRunsOptions) {
    this.newId = o.newId ?? randomUUID;
  }

  /** A `hook/started` (`done` false) or `hook/completed` notification of this thread. */
  handle(turnId: string | null, run: HookRunSummary, done: boolean): void {
    if (!done) {
      this.started(turnId, run);
      return;
    }
    const open = this.take(run.id, turnId);
    const item = codexHookRun(run, true, open?.itemId ?? this.itemId());
    if (open?.turnId) {
      this.o.emit(open.turnId, "item.completed", item);
      return;
    }
    const target = this.target(turnId);
    if (target) this.o.emit(target, "item.completed", item);
    else {
      if (this.held.length >= MAX_RUNS) this.held.shift();
      this.held.push(item);
    }
  }

  /** A turn began: the runs that waited for one show in it. */
  turnStarted(turnId: string): void {
    const held = this.held;
    this.held = [];
    for (const item of held) this.o.emit(turnId, "item.completed", item);
    for (const runs of this.open.values()) {
      for (const run of runs) {
        if (run.turnId) continue;
        run.turnId = turnId;
        this.o.emit(turnId, "item.started", run.item);
      }
    }
  }

  /**
   * A turn ended. Runs still going in a turn that didn't complete end as cancelled; in a
   * completed turn they stay open for Codex to report.
   */
  turnEnded(turnId: string, completed: boolean): void {
    if (completed) return;
    for (const [runId, runs] of this.open) {
      const keep = runs.filter((run) => run.turnId !== turnId);
      for (const run of runs) {
        if (run.turnId !== turnId) continue;
        const outcome = "cancelled";
        this.o.emit(turnId, "item.completed", {
          ...run.item,
          status: HOOK_RUN_STATUS[outcome],
          outcome,
        });
      }
      this.openCount -= runs.length - keep.length;
      if (keep.length > 0) this.open.set(runId, keep);
      else this.open.delete(runId);
    }
  }

  private started(turnId: string | null, run: HookRunSummary): void {
    const target = this.target(turnId);
    const item = codexHookRun(run, false, this.itemId());
    if (this.openCount >= MAX_RUNS) this.dropOldest();
    const runs = this.open.get(run.id) ?? [];
    runs.push({ itemId: item.id, ...(target ? { turnId: target } : {}), item });
    this.open.set(run.id, runs);
    this.openCount++;
    if (target) this.o.emit(target, "item.started", item);
  }

  /** The open run of handler `runId` a completion belongs to: the one in its turn, else the oldest. */
  private take(runId: string, turnId: string | null): OpenRun | undefined {
    const runs = this.open.get(runId);
    if (!runs || runs.length === 0) return undefined;
    const at = Math.max(
      0,
      runs.findIndex((run) => run.turnId === turnId),
    );
    const [open] = runs.splice(at, 1);
    if (runs.length === 0) this.open.delete(runId);
    this.openCount--;
    return open;
  }

  /** The turn a run reported for `turnId` shows in, begun if need be; none between turns. */
  private target(turnId: string | null): string | undefined {
    const target = turnId ?? this.o.current();
    if (target && target !== this.o.current()) this.o.beginTurn(target);
    return target;
  }

  /** Forget the oldest open run, one that never reported back. */
  private dropOldest(): void {
    const [runId, runs] = this.open.entries().next().value ?? [];
    if (!runId || !runs) return;
    runs.shift();
    this.openCount--;
    if (runs.length === 0) this.open.delete(runId);
  }

  private itemId(): string {
    return `hook-${this.newId()}`;
  }
}
