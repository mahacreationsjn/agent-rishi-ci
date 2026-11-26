import type { CheckResult, CheckRunData, CheckStatus, ItemOf } from "@agent-rishi/contracts";
import { useMutation } from "@tanstack/react-query";
import {
  AlarmClockOff,
  ChevronRight,
  CircleCheck,
  CircleDashed,
  CircleSlash,
  CircleX,
  ListChecks,
  Loader2,
  Square,
} from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { useClient } from "@/lib/api";
import { duration } from "@/lib/format";
import { cn } from "@/lib/utils";

const look: Record<CheckStatus, { icon: typeof CircleCheck; tone: string; label: string }> = {
  pending: { icon: CircleDashed, tone: "text-muted-foreground/60", label: "Waiting" },
  running: { icon: Loader2, tone: "text-status-running animate-spin", label: "Running" },
  passed: { icon: CircleCheck, tone: "text-status-done", label: "Passed" },
  failed: { icon: CircleX, tone: "text-status-failed", label: "Failed" },
  timed_out: { icon: AlarmClockOff, tone: "text-status-failed", label: "Timed out" },
  cancelled: { icon: CircleSlash, tone: "text-muted-foreground", label: "Not run" },
};

/** One check: its status, command and duration; its output opens below it. */
function CheckRow({ check }: { check: CheckResult }) {
  const [open, setOpen] = useState(false);
  const l = look[check.status];
  const output = check.output?.trim();
  const detail =
    check.status === "failed" && check.exitCode !== null ? `exit ${check.exitCode}` : null;
  return (
    <li>
      <button
        type="button"
        className={cn(
          "flex w-full items-center gap-2 rounded-md px-1.5 py-1 text-left text-2xs",
          output ? "hover:bg-accent/60" : "cursor-default",
        )}
        onClick={() => output && setOpen(!open)}
        aria-expanded={output ? open : undefined}
        aria-label={`${check.command}: ${l.label}`}
      >
        <l.icon className={cn("size-3.5 shrink-0", l.tone)} />
        <code
          className="min-w-0 flex-1 truncate font-mono text-[11.5px] text-foreground"
          title={check.command}
        >
          {check.command}
        </code>
        {detail && <span className="shrink-0 text-status-failed">{detail}</span>}
        {check.durationMs !== undefined && (
          <span className="shrink-0 tabular-nums text-muted-foreground">
            {duration(check.durationMs)}
          </span>
        )}
        {output && (
          <ChevronRight
            className={cn("size-3 shrink-0 text-muted-foreground transition-transform", {
              "rotate-90": open,
            })}
          />
        )}
      </button>
      {open && output && (
        <pre className="mx-1.5 mt-0.5 mb-1 max-h-72 overflow-auto rounded-md bg-muted/50 px-2.5 py-2 font-mono text-[11px] whitespace-pre-wrap text-muted-foreground scroll-thin">
          {check.truncated ? `…\n${output}` : output}
        </pre>
      )}
    </li>
  );
}

/**
 * A check run after a turn (§9 Project checks): each of the session's checks with how it ended
 * and how long it took, its output on demand, and the run's outcome. While the checks run, Stop
 * ends the loop.
 */
export function CheckRunCard({
  item,
  data,
  sessionId,
}: {
  item: ItemOf<"notice">;
  data: CheckRunData;
  sessionId: string;
}) {
  const client = useClient();
  const stop = useMutation({
    mutationFn: () => client.interrupt(sessionId),
    onError: (e) => toast.error("Couldn't stop the checks", { description: e.message }),
  });
  const running = item.status === "in_progress";
  const failed = data.outcome !== undefined && data.outcome !== "passed";
  return (
    <div
      className={cn(
        "rounded-lg border px-2 py-1.5",
        failed ? "border-status-failed/25 bg-status-failed/[0.04]" : "border-border/70 bg-muted/20",
      )}
      data-testid="check-run-card"
    >
      <div className="flex items-center gap-2 px-1.5 pb-0.5 text-2xs text-muted-foreground">
        <ListChecks className="size-3.5 shrink-0" />
        <span className="min-w-0 flex-1 truncate">{item.message}</span>
        {data.round > 0 && (
          <span className="shrink-0 tabular-nums">
            Round {data.round} of {data.maxRounds}
          </span>
        )}
        {running && (
          <Button
            size="sm"
            variant="ghost"
            className="h-6 gap-1 px-2 text-2xs"
            disabled={stop.isPending}
            onClick={() => stop.mutate()}
          >
            <Square className="size-2.5 fill-current" /> Stop
          </Button>
        )}
      </div>
      <ul>
        {data.checks.map((check, i) => (
          // Commands can repeat; their place in the run is stable.
          // biome-ignore lint/suspicious/noArrayIndexKey: the order never changes
          <CheckRow key={i} check={check} />
        ))}
      </ul>
    </div>
  );
}
