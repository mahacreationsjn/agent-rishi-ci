import type { FactoryWorkItem } from "@agent-rishi/contracts";
import { Link } from "@tanstack/react-router";
import type { CSSProperties, ReactNode } from "react";
import { useRetryItem } from "@/components/factory/use-retry-item";
import { Button } from "@/components/ui/button";
import { platform } from "@/lib/platform";
import { cn } from "@/lib/utils";
import type { AgentCardModel } from "../scene/agent-card";
import type { AgentStatus, SceneAgent } from "../scene/agents";
import type { BayCrate } from "../scene/repair-bay";
import { cardNumber, type ViewCard } from "../stages";

/**
 * Floor mode's cards (#264, #420, #476): what an agent is doing, on hover or keyboard focus of
 * its figure or roster row, and what a repair bay crate holds with the button that moves each
 * item on (the same Retry and Open PR as the item page). They stay open while the pointer is on
 * the thing or the card, so their buttons can be used; Escape closes them.
 */

export const STATUS_DOT: Record<AgentStatus, string> = {
  working: "bg-status-running",
  thinking: "bg-status-running/50",
  approval: "bg-status-waiting",
  blocked: "bg-status-idle",
  done: "bg-status-done",
  idle: "bg-status-idle",
};

function Card({
  id,
  style,
  children,
  onEnter,
  onLeave,
  testId,
  label,
}: {
  id?: string;
  style?: CSSProperties;
  children: ReactNode;
  onEnter: () => void;
  onLeave: () => void;
  testId: string;
  label: string;
}) {
  return (
    <section
      id={id}
      aria-label={label}
      className="z-20 w-72 max-w-[min(18rem,80vw)] overflow-hidden rounded-lg border border-border bg-popover text-xs text-popover-foreground shadow-lg"
      style={style}
      onMouseEnter={onEnter}
      onMouseLeave={onLeave}
      onFocus={onEnter}
      onBlur={onLeave}
      data-testid={testId}
    >
      {children}
    </section>
  );
}

/** The agent's card: role, item, step, provider and model, progress, time in step, status. */
export function AgentCardView({
  id,
  agent,
  card,
  style,
  onEnter,
  onLeave,
  onOpenItem,
  recent,
}: {
  id?: string;
  agent: SceneAgent;
  card: AgentCardModel;
  /** Where it goes: beside a roster row, or over its figure. */
  style?: CSSProperties;
  onEnter: () => void;
  onLeave: () => void;
  /** Its latest activities (the thought bubbles' history). */
  recent?: ReactNode;
  /** Opens its item's sheet (the PM: its chat). */
  onOpenItem: (() => void) | null;
}) {
  return (
    <Card
      id={id}
      style={style}
      onEnter={onEnter}
      onLeave={onLeave}
      testId="factory-view-floor-card"
      label={`${card.role}: ${card.status}`}
    >
      <header className="flex items-center gap-1.5 border-b border-border bg-muted/50 px-2.5 py-1.5">
        <span className="font-semibold">{card.role}</span>
        <span
          className="ml-auto inline-flex items-center gap-1 text-2xs text-muted-foreground"
          data-testid="factory-view-floor-card-status"
        >
          <span aria-hidden className={cn("size-2 rounded-full", STATUS_DOT[card.statusKind])} />
          {card.status}
        </span>
      </header>
      <div className="space-y-1.5 px-2.5 py-2">
        {(card.refs || card.title) && (
          <p>
            {card.refs && <span className="mr-1 font-semibold">{card.refs}</span>}
            {card.title}
          </p>
        )}
        <dl className="grid grid-cols-[auto_1fr] gap-x-2 gap-y-0.5 text-muted-foreground">
          <dt>Step</dt>
          <dd className="font-medium text-foreground">{card.step}</dd>
          {card.inStep && (
            <>
              <dt>In step</dt>
              <dd>{card.inStep}</dd>
            </>
          )}
          <dt>Agent</dt>
          <dd>{card.model}</dd>
        </dl>
        {card.progress && (
          <p className="rounded border border-border bg-muted/40 px-1.5 py-1 italic">
            “{card.progress}”
          </p>
        )}
        {recent}
        {(onOpenItem || agent.sessionId) && (
          <div className="flex flex-wrap gap-1.5 pt-0.5">
            {onOpenItem && (
              <Button size="xs" onClick={onOpenItem}>
                {agent.role === "pm" ? "Chat" : "Open item"}
              </Button>
            )}
            {agent.sessionId && (
              <Button size="xs" variant="outline" asChild>
                <Link
                  to="/sessions/$sessionId"
                  params={{ sessionId: agent.sessionId }}
                  data-testid="factory-view-floor-card-session"
                >
                  Open session
                </Link>
              </Button>
            )}
          </div>
        )}
      </div>
    </Card>
  );
}

function RetryAction({ projectId, item }: { projectId: string; item: FactoryWorkItem }) {
  const retry = useRetryItem(projectId, item.id);
  return (
    <Button
      size="xs"
      disabled={retry.isPending}
      onClick={() => retry.mutate()}
      aria-label={`Retry ${cardNumber(item)}`}
    >
      Retry
    </Button>
  );
}

/** A repair bay crate: each item in it, why it stopped and what to do. */
export function BayCardView({
  id,
  crate,
  style,
  projectId,
  onEnter,
  onLeave,
  onOpen,
}: {
  id?: string;
  crate: BayCrate;
  style?: CSSProperties;
  projectId: string;
  onEnter: () => void;
  onLeave: () => void;
  onOpen: (card: ViewCard) => void;
}) {
  return (
    <Card
      id={id}
      style={style}
      onEnter={onEnter}
      onLeave={onLeave}
      testId="factory-view-floor-bay-card"
      label={`Repair bay: ${crate.title}`}
    >
      <header className="flex items-center border-b border-border bg-status-failed/10 px-2.5 py-1.5 font-semibold text-status-failed">
        <span>{crate.title}</span>
        <span className="ml-auto tabular-nums">{crate.entries.length}</span>
      </header>
      <ul className="max-h-56 divide-y divide-border overflow-y-auto scroll-thin">
        {crate.entries.map((e) => {
          const pr = e.card.pr?.pr ?? e.card.item.ownedPr ?? e.card.item.pr;
          return (
            <li
              key={e.card.item.id}
              className="space-y-1 px-2.5 py-1.5"
              data-testid="factory-view-floor-bay-entry"
            >
              <button
                type="button"
                className="block text-left font-medium hover:underline"
                onClick={() => onOpen(e.card)}
              >
                {cardNumber(e.card.item)} {e.card.item.title}
              </button>
              <p className="text-muted-foreground">{e.label}</p>
              <div className="flex gap-1.5">
                {e.action === "retry" && <RetryAction projectId={projectId} item={e.card.item} />}
                {e.action === "open_pr" && pr && (
                  <Button size="xs" variant="outline" onClick={() => platform.openExternal(pr.url)}>
                    Open PR #{pr.number}
                  </Button>
                )}
              </div>
            </li>
          );
        })}
      </ul>
    </Card>
  );
}
