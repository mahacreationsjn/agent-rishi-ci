import type { HookRunOutcome } from "@agent-rishi/contracts";
import {
  ChevronRight,
  CircleSlash,
  Loader2,
  ShieldAlert,
  TriangleAlert,
  Webhook,
} from "lucide-react";
import { useState } from "react";
import { duration } from "@/lib/format";
import { type HookRun, hooksRan } from "@/lib/transcript/timeline";
import { cn } from "@/lib/utils";

const OUTCOME: Record<HookRunOutcome, string> = {
  running: "running",
  succeeded: "ran",
  failed: "failed",
  blocked: "blocked",
  cancelled: "cancelled",
};

/** First line of a run's output: the reason a failed or blocked run shows inline. */
function firstLine(text: string | undefined): string | undefined {
  return text
    ?.split("\n")
    .find((line) => line.trim())
    ?.trim();
}

/** "exit 2" when the provider reported an exit code that says something. */
function exitText(run: HookRun): string | undefined {
  return typeof run.exitCode === "number" && run.exitCode !== 0
    ? `exit ${run.exitCode}`
    : undefined;
}

function Output({ run }: { run: HookRun }) {
  return (
    <div className="mt-1 mb-2 ml-6 space-y-1 rounded-lg border border-border bg-surface p-2.5 font-mono text-[11.5px] wrap-anywhere text-muted-foreground">
      {run.source && (
        <p className="truncate text-3xs" title={run.source}>
          {run.source}
        </p>
      )}
      {run.output ? (
        <pre className="max-h-48 overflow-auto whitespace-pre-wrap text-foreground/80 scroll-thin">
          {run.output}
        </pre>
      ) : (
        <p className="text-3xs">No output.</p>
      )}
      {run.outputTruncated && <p className="text-3xs">Output cut to its start and end.</p>}
    </div>
  );
}

/**
 * One hook run from the user's settings (§12.4): a 26px row with its event, what ran, how it
 * ended and how long it took; the output opens below. A failed or blocked run (`warn`, on a row
 * of its own) uses the warning colour and shows its reason inline.
 */
export function HookRow({ run, warn = false }: { run: HookRun; warn?: boolean }) {
  const [open, setOpen] = useState(false);
  const running = run.outcome === "running";
  const reason = warn ? firstLine(run.output) : undefined;
  const meta = [OUTCOME[run.outcome], exitText(run)].filter(Boolean).join(" · ");
  const Icon = running
    ? Loader2
    : run.outcome === "blocked"
      ? ShieldAlert
      : run.outcome === "failed"
        ? TriangleAlert
        : run.outcome === "cancelled"
          ? CircleSlash
          : Webhook;
  return (
    <div
      className={cn(
        warn && "rounded-lg border border-status-waiting/25 bg-status-waiting/[0.06] px-1",
      )}
    >
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        title={run.source}
        className="group/hook flex h-[26px] pointer-coarse:h-10 w-full min-w-0 items-center gap-2 rounded-md px-1.5 text-left text-[13px] transition-colors hover:bg-accent/50"
      >
        <span
          className={cn(
            "flex size-4 shrink-0 items-center justify-center",
            warn ? "text-status-waiting" : "text-muted-foreground",
          )}
        >
          <Icon className={cn("size-3.5", running && "animate-spin")} />
        </span>
        <span
          className={cn(
            "shrink-0",
            warn ? "text-status-waiting" : "text-muted-foreground",
            running && "text-shine",
          )}
        >
          {run.event} hook
        </span>
        {run.label && (
          // Short labels stay whole; a long one stops at 40% so the outcome keeps its room.
          <span className="min-w-0 max-w-[40%] shrink-0 truncate font-mono text-[12px] text-foreground/80">
            {run.label}
          </span>
        )}
        <span
          className={cn(
            "shrink-0 text-2xs",
            warn ? "font-medium text-status-waiting" : "text-muted-foreground/70",
          )}
        >
          {meta}
        </span>
        {reason && (
          <span className="min-w-0 flex-1 truncate text-2xs text-status-waiting/90" title={reason}>
            {reason}
          </span>
        )}
        <span className="ml-auto flex shrink-0 items-center gap-1.5 pl-2">
          {run.durationMs !== undefined && !running && (
            <span className="text-3xs text-muted-foreground/60 tabular-nums">
              {duration(run.durationMs)}
            </span>
          )}
          <ChevronRight
            className={cn(
              "size-3 text-muted-foreground/50 opacity-0 transition group-hover/hook:opacity-100",
              open && "rotate-90 opacity-100",
            )}
          />
        </span>
      </button>
      {open && <Output run={run} />}
    </div>
  );
}

/** Hook runs that succeeded one after another: one "3 hooks ran" row that opens into theirs. */
export function HookBatchRow({ runs }: { runs: HookRun[] }) {
  const [open, setOpen] = useState(false);
  const ms = runs.reduce((sum, r) => sum + (r.durationMs ?? 0), 0);
  const events = [...new Set(runs.map((r) => r.event))].join(", ");
  return (
    <div>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="group/hooks flex h-[26px] pointer-coarse:h-10 w-full min-w-0 items-center gap-2 rounded-md px-1.5 text-left text-[13px] transition-colors hover:bg-accent/50"
      >
        <span className="flex size-4 shrink-0 items-center justify-center text-muted-foreground">
          <Webhook className="size-3.5" />
        </span>
        <span className="shrink-0 text-muted-foreground">{hooksRan(runs.length)}</span>
        <span className="min-w-0 truncate text-2xs text-muted-foreground/70">{events}</span>
        <span className="ml-auto flex shrink-0 items-center gap-1.5 pl-2">
          {ms > 0 && (
            <span className="text-3xs text-muted-foreground/60 tabular-nums">{duration(ms)}</span>
          )}
          <ChevronRight
            className={cn(
              "size-3 text-muted-foreground/50 opacity-0 transition group-hover/hooks:opacity-100",
              open && "rotate-90 opacity-100",
            )}
          />
        </span>
      </button>
      {open && (
        <div className="relative mt-0.5 ml-[13px] border-l border-border pl-2.5">
          {runs.map((run) => (
            <HookRow key={run.id} run={run} />
          ))}
        </div>
      )}
    </div>
  );
}
