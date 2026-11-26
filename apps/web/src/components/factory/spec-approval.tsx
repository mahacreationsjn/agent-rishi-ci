import {
  type FactoryItem,
  type FactorySpecDecisionRequest,
  SPEC_FEEDBACK_MAX,
  type SpecApproval,
} from "@agent-rishi/contracts";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Check, MessageSquareWarning, PencilLine } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { SectionLabel } from "@/components/common/bits";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { useClient } from "@/lib/api";
import { factoryKeys } from "@/lib/factory";
import { ago } from "@/lib/format";

/**
 * The optional spec approval (§10.1, "Approve specs before building"): a feature's spec waits for
 * you after Analyze. Approve it and the agent builds it; ask for changes and it revises its
 * analysis first. Used on the item page and on the spec's inbox card.
 */

/**
 * Approve a spec that waits for you, or ask for changes (with what to change). The decision
 * carries the version shown, so one made on a spec the agent revised since is refused.
 */
export function SpecDecision({
  projectId,
  itemId,
  version,
  compact = false,
}: {
  projectId: string;
  itemId: string;
  /** The version of the spec shown (`SpecApproval.requestedAt`). */
  version: string;
  /** Smaller buttons, for an inbox card. */
  compact?: boolean;
}) {
  const client = useClient();
  const queryClient = useQueryClient();
  const [asking, setAsking] = useState(false);
  const [feedback, setFeedback] = useState("");
  const decide = useMutation({
    mutationFn: (req: FactorySpecDecisionRequest) =>
      client.factory.decideSpec(projectId, itemId, { ...req, version }),
    onSuccess: (_item, req) => {
      toast.success(
        req.decision === "approve"
          ? "Spec approved: the agent builds it next"
          : "Changes requested: the agent revises the spec",
      );
      setAsking(false);
      setFeedback("");
      void queryClient.invalidateQueries({ queryKey: factoryKeys.all });
    },
    onError: (e: Error) => {
      toast.error("Couldn't record your decision", { description: e.message });
      // The spec changed or was decided meanwhile: show it as it is now.
      void queryClient.invalidateQueries({ queryKey: factoryKeys.all });
    },
  });
  const size = compact ? "sm" : "default";
  const text = feedback.trim();
  return (
    <div className="space-y-2" data-testid="spec-decision">
      <div className="flex flex-wrap gap-1.5">
        <Button
          size={size}
          onClick={() => decide.mutate({ decision: "approve" })}
          disabled={decide.isPending}
        >
          <Check /> Approve spec
        </Button>
        <Button
          size={size}
          variant={asking ? "secondary" : "outline"}
          onClick={() => setAsking((v) => !v)}
          disabled={decide.isPending}
          aria-expanded={asking}
        >
          <PencilLine /> Request changes
        </Button>
      </div>
      {asking && (
        <div className="space-y-1.5">
          <Textarea
            value={feedback}
            onChange={(e) => setFeedback(e.target.value)}
            maxLength={SPEC_FEEDBACK_MAX}
            placeholder="What should change? The agent revises its analysis and asks you again."
            aria-label="What to change in the spec"
            className="min-h-20 text-[13px]"
            autoFocus
          />
          <Button
            size="sm"
            onClick={() => decide.mutate({ decision: "request_changes", feedback: text })}
            disabled={decide.isPending || !text}
          >
            Send to the agent
          </Button>
        </div>
      )}
    </div>
  );
}

/** Why a revised analysis decided not to build the feature after all. */
const NOT_BUILT: Record<string, string> = {
  already_done: "it is already possible",
  needs_info: "it needs more information",
  out_of_scope: "it is out of scope for the vision",
};

/**
 * After a request for changes: the agent revises its analysis while the item is in building;
 * once it stopped, what the revision decided (or that it stopped before one was submitted).
 */
function ChangesRequested({ item, spec }: { item: FactoryItem; spec: SpecApproval }) {
  const asked = `Changes requested${spec.decidedAt ? ` ${ago(spec.decidedAt)}` : ""}`;
  const inv = item.investigation;
  const notBuilt = inv?.kind === "analysis" && inv.outcome !== "implement";
  const text =
    item.stage === "building"
      ? `${asked}: the agent revises its analysis, then asks you again.`
      : notBuilt
        ? `${asked}. The revised analysis decided not to build it: ${NOT_BUILT[inv.outcome] ?? inv.outcome}.`
        : `${asked}. The item stopped before the agent submitted a revised spec.`;
  return (
    <p className="flex items-start gap-2">
      <MessageSquareWarning className="mt-0.5 size-3.5 shrink-0 text-status-waiting" />
      <span>
        {text}
        {spec.feedback && (
          <span className="mt-1 block text-2xs text-muted-foreground">{spec.feedback}</span>
        )}
      </span>
    </p>
  );
}

/**
 * Where the item's spec is in its approval, on the item page: the decision controls while it
 * waits for you, then what was decided. Nothing for a spec that needed no approval.
 */
export function SpecApprovalCard({ item, projectId }: { item: FactoryItem; projectId: string }) {
  const spec = item.specApproval;
  if (!spec) return null;
  const waiting = spec.state === "pending" && item.stage === "building";
  return (
    <section data-testid="spec-approval">
      <SectionLabel className="mb-2">Spec approval</SectionLabel>
      {waiting ? (
        <div className="space-y-3 rounded-xl border border-status-waiting/35 bg-status-waiting/[0.06] p-4 text-[13px]">
          <p className="leading-relaxed">
            <span className="font-medium">The spec waits for you</span>
            <span className="text-muted-foreground">
              {" "}
              (submitted {ago(spec.requestedAt)}). Read the analysis and the acceptance criteria
              above. Approve it and the agent builds it; ask for changes and it revises the spec
              first.
            </span>
          </p>
          {spec.feedback && (
            <p className="text-2xs text-muted-foreground">
              You asked earlier: <span className="text-foreground">{spec.feedback}</span>
            </p>
          )}
          <SpecDecision projectId={projectId} itemId={item.id} version={spec.requestedAt} />
        </div>
      ) : (
        <div className="rounded-xl border border-border bg-card p-4 text-[13px]">
          {spec.state === "changes_requested" ? (
            <ChangesRequested item={item} spec={spec} />
          ) : spec.state === "approved" ? (
            <p className="flex items-start gap-2">
              <Check className="mt-0.5 size-3.5 shrink-0 text-status-done" />
              <span>
                {spec.by === "auto"
                  ? "Approved automatically: spec approval was turned off while it waited."
                  : `Approved by you${spec.decidedAt ? ` ${ago(spec.decidedAt)}` : ""}.`}
                {spec.rounds > 0 &&
                  ` After ${spec.rounds} round${spec.rounds === 1 ? "" : "s"} of changes.`}
              </span>
            </p>
          ) : (
            <p className="text-muted-foreground">
              It was waiting for approval when the item stopped.
            </p>
          )}
        </div>
      )}
    </section>
  );
}
