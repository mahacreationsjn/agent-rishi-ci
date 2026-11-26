import { Link } from "@tanstack/react-router";
import { ExternalLink, FileCheck, MessageCircleQuestion } from "lucide-react";
import { FactoryFailureActions } from "@/components/factory/failure-actions";
import { Button } from "@/components/ui/button";
import { platform } from "@/lib/platform";
import { cn } from "@/lib/utils";
import { cardNumber, type ViewCard } from "./stages";
import { ViewCardButton } from "./view-card";

/**
 * What a "Needs you" card asks of a person, and the buttons that do it in place: open the pull
 * request to review and merge it, retry or dismiss stopped work, open the agent's session to
 * answer it, or open the item to approve its spec.
 */
export function NeedActions({
  card,
  projectId,
  className,
}: {
  card: ViewCard;
  projectId: string;
  className?: string;
}) {
  const need = card.need;
  const name = cardNumber(card.item);
  if (!need) return null;
  const prUrl = card.pr?.pr.url ?? card.item.ownedPr?.url ?? card.item.pr?.url ?? null;
  return (
    <div
      className={cn("flex flex-wrap items-center gap-1", className)}
      data-testid="factory-view-need"
      data-need={need.kind}
    >
      <span className="mr-auto min-w-0 text-2xs font-medium text-status-waiting">{need.label}</span>
      {need.kind === "merge" && prUrl && (
        <Button size="xs" variant="outline" onClick={() => platform.openExternal(prUrl)}>
          <ExternalLink /> Open PR
        </Button>
      )}
      {(need.kind === "retry" || need.kind === "retry_or_dismiss") && (
        <FactoryFailureActions
          projectId={projectId}
          itemId={card.item.id}
          name={name}
          canDismiss={need.kind === "retry_or_dismiss"}
        />
      )}
      {need.kind === "answer" && card.sessionId && (
        <Button size="xs" variant="outline" asChild>
          <Link to="/sessions/$sessionId" params={{ sessionId: card.sessionId }}>
            <MessageCircleQuestion /> Answer
          </Link>
        </Button>
      )}
      {need.kind === "approve_spec" && (
        <Button size="xs" variant="outline" asChild>
          <Link
            to="/projects/$projectId/factory/$itemId"
            params={{ projectId, itemId: card.item.id }}
            aria-label={`Review the spec of ${name}`}
          >
            <FileCheck /> Review spec
          </Link>
        </Button>
      )}
    </div>
  );
}

/** A card in the "Needs you" lane: the card (opens its sheet) with what it needs below. */
export function NeedsYouCard({
  card,
  now,
  onOpen,
  projectId,
}: {
  card: ViewCard;
  now: number;
  onOpen: (card: ViewCard) => void;
  projectId: string;
}) {
  return (
    <div className="flex flex-col">
      <ViewCardButton
        card={card}
        now={now}
        onOpen={onOpen}
        className="rounded-b-none border-b-0 shadow-none"
      />
      <NeedActions
        card={card}
        projectId={projectId}
        className={cn(
          "rounded-b-lg border px-2.5 py-1.5",
          card.state === "failed"
            ? "border-status-failed/50 bg-status-failed/[0.05]"
            : "border-status-waiting/50 bg-status-waiting/[0.05]",
        )}
      />
    </div>
  );
}
