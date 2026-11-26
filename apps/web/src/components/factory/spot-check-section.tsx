import type { FactoryItem } from "@agent-rishi/contracts";
import { Check, Eye, TriangleAlert } from "lucide-react";
import { SectionLabel } from "@/components/common/bits";
import { ago } from "@/lib/format";
import { platform } from "@/lib/platform";
import { FileSpotCheckIssueButton, OpenPrButton, SpotCheckDecision } from "./spot-check-actions";
import { SPOT_CHECK_REASON } from "./spot-checks";

/**
 * The item page's spot-check (§10.1): why its merge was set aside for a person's look, and what
 * they found, with the same actions as the factory panel's Spot-checks list. Nothing for a merge
 * that wasn't set aside.
 */
export function SpotCheckSection({ item, projectId }: { item: FactoryItem; projectId: string }) {
  const check = item.spotCheck;
  if (!check) return null;
  const reason = SPOT_CHECK_REASON[check.reason];
  return (
    <section data-testid="spot-check">
      <SectionLabel className="mb-2">Spot-check</SectionLabel>
      <div className="space-y-2 rounded-xl border border-border bg-card p-4 text-[13px]">
        {check.state === "pending" ? (
          <>
            <p className="flex items-start gap-2">
              <Eye className="mt-0.5 size-3.5 shrink-0 text-status-waiting" />
              <span>
                <span className="font-medium">Set aside for a quick look</span>
                <span className="text-muted-foreground">
                  {" "}
                  ({reason.label.toLowerCase()}, merged {ago(check.sampledAt)}). Read the change,
                  then record what you found. Nothing waits on it.
                </span>
              </span>
            </p>
            <div className="flex flex-wrap gap-1">
              {item.pr && (
                <OpenPrButton
                  projectId={projectId}
                  pr={item.pr}
                  itemId={item.id}
                  title={item.title}
                />
              )}
              <SpotCheckDecision projectId={projectId} itemId={item.id} title={item.title} />
            </div>
          </>
        ) : (
          <div className="flex items-start gap-2">
            {check.state === "problem" ? (
              <TriangleAlert className="mt-0.5 size-3.5 shrink-0 text-status-failed" />
            ) : (
              <Check className="mt-0.5 size-3.5 shrink-0 text-status-done" />
            )}
            <div className="min-w-0 flex-1 space-y-1">
              <p>
                {check.state === "problem" ? "A person found a problem" : "Looks good to a person"}
                <span className="text-muted-foreground">
                  {check.checkedAt && ` · ${ago(check.checkedAt)}`} · {reason.label.toLowerCase()}
                </span>
              </p>
              {check.note && (
                <p className="text-2xs whitespace-pre-wrap text-muted-foreground">{check.note}</p>
              )}
              {check.state === "problem" &&
                (check.issue ? (
                  <button
                    type="button"
                    className="text-2xs text-muted-foreground hover:text-foreground hover:underline"
                    onClick={() => check.issue && platform.openExternal(check.issue.url)}
                  >
                    Follow-up issue #{check.issue.number}
                  </button>
                ) : (
                  <FileSpotCheckIssueButton projectId={projectId} itemId={item.id} />
                ))}
            </div>
          </div>
        )}
      </div>
    </section>
  );
}
