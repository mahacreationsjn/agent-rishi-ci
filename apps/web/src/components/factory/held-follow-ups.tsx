import type { HeldFollowUp } from "@agent-rishi/contracts";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { FilePlus, X } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { useClient } from "@/lib/api";
import { factoryKeys } from "@/lib/factory";
import { platform } from "@/lib/platform";
import { cn } from "@/lib/utils";
import { SEVERITY_TONE } from "./follow-ups";

/**
 * The review follow-ups a dark factory holds for its scout (§10.1, #435): the count on the scout's
 * card opens the list, each with its source PR and severity, File now (an issue at once, outside
 * the round's cap) and Dismiss.
 */

export const HELD_FOLLOW_UPS_HELP =
  "Non-blocking findings from the reviews of merged pull requests. The scout weighs them with its area reviewers' findings and files at most Issues per round in total; ones it doesn't file are dropped after 14 days.";

type Action = "file" | "dismiss";

export function HeldFollowUps({
  projectId,
  held,
  className,
}: {
  projectId: string;
  held: HeldFollowUp[];
  className?: string;
}) {
  const client = useClient();
  const queryClient = useQueryClient();
  const act = useMutation({
    mutationFn: ({ h, action }: { h: HeldFollowUp; action: Action }) =>
      action === "file"
        ? client.factory.fileFollowUp(projectId, h.itemId, h.index)
        : client.factory.dismissFollowUp(projectId, h.itemId, h.index),
    onSuccess: (next, { h, action }) => {
      const issue = next.followUps[h.index]?.issue;
      toast.success(
        action === "dismiss" ? "Dismissed" : issue ? `Filed as #${issue.number}` : "Filed",
      );
      void queryClient.invalidateQueries({ queryKey: factoryKeys.all });
    },
    onError: (e: Error, { action }) =>
      toast.error(action === "file" ? "Couldn't file the issue" : "Couldn't dismiss it", {
        description: e.message,
      }),
  });
  if (held.length === 0) return null;
  const label = `${held.length} held follow-up${held.length === 1 ? "" : "s"}`;
  return (
    <Popover>
      <PopoverTrigger asChild>
        <button
          type="button"
          className={cn(
            "text-[10px] text-muted-foreground underline decoration-dotted underline-offset-2 hover:text-primary",
            className,
          )}
          data-testid="held-follow-ups"
        >
          {label}
        </button>
      </PopoverTrigger>
      <PopoverContent className="w-96 gap-0 p-0">
        <div className="border-b border-border px-3 py-2">
          <div className="text-[13px] font-medium">Held review follow-ups</div>
          <p className="mt-0.5 text-2xs text-muted-foreground">{HELD_FOLLOW_UPS_HELP}</p>
        </div>
        <ul className="max-h-80 overflow-y-auto" aria-label="Held review follow-ups">
          {held.map((h) => {
            const busy = act.isPending && act.variables?.h.id === h.id;
            return (
              <li
                key={h.id}
                className="flex flex-col gap-1 border-b border-border px-3 py-2 last:border-0"
              >
                <span className="text-[12px] leading-snug">{h.title}</span>
                <span className="flex items-center gap-1.5 text-3xs text-muted-foreground">
                  <span
                    className={cn(
                      "rounded-full border px-1.5",
                      SEVERITY_TONE[h.severity ?? "medium"],
                    )}
                  >
                    {h.severity ?? "medium"}
                  </span>
                  {h.area && (
                    <span className="rounded-full border border-border px-1.5 font-mono">
                      {h.area}
                    </span>
                  )}
                  {h.pr ? (
                    <button
                      type="button"
                      className="truncate text-primary hover:underline"
                      title={h.itemTitle}
                      onClick={() => h.pr && platform.openExternal(h.pr.url)}
                    >
                      from PR #{h.pr.number}
                    </button>
                  ) : (
                    <span className="truncate" title={h.itemTitle}>
                      from {h.itemTitle}
                    </span>
                  )}
                  <span className="flex-1" />
                  <Button
                    size="xs"
                    variant="outline"
                    disabled={busy}
                    onClick={() => act.mutate({ h, action: "file" })}
                  >
                    <FilePlus /> File now
                  </Button>
                  <Button
                    size="xs"
                    variant="ghost"
                    disabled={busy}
                    onClick={() => act.mutate({ h, action: "dismiss" })}
                    aria-label={`Dismiss "${h.title}"`}
                  >
                    <X /> Dismiss
                  </Button>
                </span>
              </li>
            );
          })}
        </ul>
      </PopoverContent>
    </Popover>
  );
}
