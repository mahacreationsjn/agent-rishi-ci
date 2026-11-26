import type {
  AutonomyMode,
  FactoryFollowUp,
  FactoryItem,
  FollowUpDropReason,
  FollowUpSeverity,
  ReviewFollowUp,
} from "@agent-rishi/contracts";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { CircleDot, FilePlus } from "lucide-react";
import { toast } from "sonner";
import { SectionLabel } from "@/components/common/bits";
import { Button } from "@/components/ui/button";
import { useClient } from "@/lib/api";
import { factoryKeys } from "@/lib/factory";
import { platform } from "@/lib/platform";
import { cn } from "@/lib/utils";

/**
 * The reviewer's follow-ups on the factory item page (§10.1): non-blocking findings that never
 * hold up the merge. Before the merge they are listed from the verdict; once it merged, each
 * shows the issue that tracks it, or "File issue" (a dark factory holds them for its scout or
 * files them by itself), with whether it is held for the scout or was dropped from that list.
 */

const DROPPED_LABEL: Record<FollowUpDropReason, string> = {
  duplicate: "duplicate",
  expired: "expired",
  capped: "dropped",
  dismissed: "dismissed",
};

export const SEVERITY_TONE: Record<FollowUpSeverity, string> = {
  high: "border-status-failed/40 text-status-failed",
  medium: "border-status-waiting/40 text-status-waiting",
  low: "border-border text-muted-foreground",
};

function Facts({ f }: { f: ReviewFollowUp }) {
  if (!f.severity && !f.area) return null;
  return (
    <span className="flex shrink-0 items-center gap-1">
      {f.severity && (
        <span className={cn("rounded-full border px-1.5 text-3xs", SEVERITY_TONE[f.severity])}>
          {f.severity}
        </span>
      )}
      {f.area && (
        <span className="rounded-full border border-border px-1.5 font-mono text-3xs text-muted-foreground">
          {f.area}
        </span>
      )}
    </span>
  );
}

export function FollowUps({
  item,
  projectId,
  mode,
}: {
  item: FactoryItem;
  projectId: string;
  mode: AutonomyMode;
}) {
  const client = useClient();
  const queryClient = useQueryClient();
  const file = useMutation({
    mutationFn: (index: number) => client.factory.fileFollowUp(projectId, item.id, index),
    onSuccess: (next, index) => {
      const issue = next.followUps[index]?.issue;
      toast.success(issue ? `Filed as #${issue.number}` : "Filed");
      void queryClient.invalidateQueries({ queryKey: factoryKeys.all });
    },
    onError: (e: Error) => toast.error("Couldn't file the issue", { description: e.message }),
  });
  const merged = item.followUps.length > 0;
  const listed: Array<ReviewFollowUp & Partial<FactoryFollowUp>> = merged
    ? item.followUps
    : (item.review?.followUps ?? []);
  if (listed.length === 0) return null;
  return (
    <section data-testid="follow-ups">
      <SectionLabel className="mb-2">Follow-ups · not blocking</SectionLabel>
      <div className="overflow-hidden rounded-xl border border-border bg-card">
        {listed.map((f, index) => {
          const issue = f.issue ?? null;
          return (
            <div
              key={f.title}
              className="flex items-center gap-3 border-b border-border px-3.5 py-2.5 text-[13px] last:border-0"
            >
              <span className="min-w-0 flex-1">{f.title}</span>
              <Facts f={f} />
              {merged && !issue && (f.dropped || f.heldAt) && (
                <span
                  className="shrink-0 text-3xs text-muted-foreground"
                  title={
                    f.dropped
                      ? "Left the scout's held list without an issue"
                      : "Held for the scout's next round"
                  }
                >
                  {f.dropped ? DROPPED_LABEL[f.dropped.reason] : "held for the scout"}
                </span>
              )}
              {merged &&
                (issue ? (
                  <button
                    type="button"
                    className="inline-flex shrink-0 items-center gap-1 text-2xs text-primary hover:underline"
                    onClick={() => platform.openExternal(issue.url)}
                  >
                    <CircleDot className="size-3" />#{issue.number}
                  </button>
                ) : (
                  <Button
                    size="xs"
                    variant="outline"
                    disabled={file.isPending}
                    onClick={() => file.mutate(index)}
                  >
                    <FilePlus /> File issue
                  </Button>
                ))}
            </div>
          );
        })}
      </div>
      <p className="mt-1.5 text-3xs text-muted-foreground">
        {merged
          ? mode === "dark_factory"
            ? "Held ones wait for the scout, which weighs them against its other findings; the rest are filed as issues."
            : "File the ones worth doing as issues; the factory picks them up from there."
          : mode === "dark_factory"
            ? "They don't hold up the merge; once it merges, high-severity and security ones are filed as issues and the rest wait for the scout's rounds."
            : "They don't hold up the merge; once it merges you can file them as issues here."}
      </p>
    </section>
  );
}
