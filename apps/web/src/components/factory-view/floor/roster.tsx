import { ChevronLeft, Users } from "lucide-react";
import { type CSSProperties, useId, useState } from "react";
import { ProviderMark } from "@/components/common/bits";
import { Sheet, SheetContent, SheetDescription, SheetTitle } from "@/components/ui/sheet";
import { cn } from "@/lib/utils";
import { agentCard } from "../scene/agent-card";
import type { AgentStatus, SceneAgent } from "../scene/agents";
import { STOREY_LABEL, type StoreyId, storeyOf } from "../scene/storeys";
import { useHover } from "../scene/use-hover";
import { AgentCardView } from "./cards";

/**
 * Floor mode's roster (#420, #476): a folding drawer on the scene's left edge that lists every
 * agent as a button, in pipeline order, then the PM, the scout and its area reviewers (grouped
 * by storey in a dark factory). It carries what the
 * canvas shows in text: role, issue and title, step, status, provider and model. Hovering or
 * focusing a row shows the agent's card beside it (Escape closes it); activating a row does what
 * clicking the agent does: opens its item, the PM's chat, or its session.
 */

const DOT: Record<AgentStatus, string> = {
  working: "bg-status-running",
  thinking: "bg-status-running/50",
  approval: "bg-status-waiting",
  blocked: "bg-status-idle",
  done: "bg-status-done",
  idle: "bg-status-idle",
};

/** Beside the row, inside the window. */
function cardBeside(row: DOMRect): CSSProperties {
  const left = row.right + 8;
  return {
    position: "fixed",
    left,
    top: Math.max(8, Math.min(row.top, window.innerHeight - 300)),
    transform: "none",
    maxWidth: `min(18rem, calc(100vw - ${left + 8}px))`,
  };
}

/** The open roster's width, with its margin, which the camera's fit keeps clear of. */
export const ROSTER_SPACE = 272;

export function Roster({
  agents,
  byStorey = false,
  sheet = false,
  now,
  open,
  setOpen,
  onActivate,
  onOpenItem,
}: {
  agents: readonly SceneAgent[];
  /** Group the crew by storey (a dark factory's Workshop and Lookout). */
  byStorey?: boolean;
  /** Phones: a bottom sheet behind a button, instead of a drawer beside the floor. */
  sheet?: boolean;
  now: number;
  open: boolean;
  setOpen: (open: boolean) => void;
  onActivate: (agent: SceneAgent) => void;
  /** What the card's main button does for an agent, or null when it has none. */
  onOpenItem: (agent: SceneAgent) => (() => void) | null;
}) {
  const hover = useHover();
  const [rect, setRect] = useState<DOMRect | null>(null);
  const ids = useId().replace(/:/g, "");
  const show = (key: string, el: HTMLElement) => {
    setRect(el.getBoundingClientRect());
    hover.enter(key);
  };
  const keep = () => hover.key && hover.enter(hover.key);
  const groups: { id: StoreyId | "all"; agents: readonly SceneAgent[] }[] = byStorey
    ? (["workshop", "lookout"] as const).map((id) => ({
        id,
        agents: agents.filter((a) => storeyOf(a) === id),
      }))
    : [{ id: "all", agents }];

  const head = (
    <>
      <Users className="size-3.5 text-primary" aria-hidden />
      <span>Crew</span>
      <span className="rounded-full bg-muted px-1.5 text-2xs tabular-nums text-muted-foreground">
        {agents.length}
      </span>
    </>
  );
  // Phones: a button over the floor opens the roster as a bottom sheet (rows only: a tap does
  // what clicking the agent does, and the sheet closes).
  if (sheet)
    return (
      <>
        <button
          type="button"
          onClick={() => setOpen(true)}
          className="absolute top-2 left-2 z-10 flex min-h-10 items-center gap-2 rounded-lg border border-border bg-background/95 px-3 text-xs font-medium shadow-md"
          data-testid="factory-view-floor-roster-open"
        >
          {head}
        </button>
        <Sheet open={open} onOpenChange={setOpen}>
          <SheetContent
            side="bottom"
            className="gap-0 rounded-t-2xl p-0 data-[side=bottom]:h-[70dvh]"
            data-testid="factory-view-floor-roster"
          >
            <SheetTitle className="flex items-center gap-2 border-b border-border px-3 py-2.5 text-sm">
              {head}
            </SheetTitle>
            <SheetDescription className="sr-only">
              Every agent on the factory floor, with its step and status
            </SheetDescription>
            {list(false)}
          </SheetContent>
        </Sheet>
      </>
    );

  return (
    <nav
      aria-label="Crew roster"
      className={cn(
        "absolute top-2 bottom-2 left-2 z-10 flex flex-col overflow-hidden rounded-lg border border-border bg-background/95 shadow-md",
        open ? "w-64" : "w-auto self-start bottom-auto",
      )}
      data-testid="factory-view-floor-roster"
    >
      <button
        type="button"
        onClick={() => setOpen(!open)}
        aria-expanded={open}
        aria-controls={`${ids}-list`}
        className="flex shrink-0 items-center gap-2 border-b border-border px-2.5 py-2 text-xs font-medium hover:bg-muted/60"
      >
        {head}
        <ChevronLeft
          className={cn(
            "ml-auto size-3.5 text-muted-foreground transition-transform",
            !open && "rotate-180",
          )}
          aria-hidden
        />
        <span className="sr-only">{open ? "Fold the roster" : "Show the roster"}</span>
      </button>
      {open && list(true)}
    </nav>
  );

  /** The rows, by storey when there are two; `cards` shows each row's card on hover or focus. */
  function list(cards: boolean) {
    return (
      <div id={`${ids}-list`} className="min-h-0 flex-1 overflow-y-auto scroll-thin">
        {groups.map((g) => (
          <section key={g.id} aria-labelledby={g.id === "all" ? undefined : `${ids}-${g.id}`}>
            {g.id !== "all" && (
              <h3
                id={`${ids}-${g.id}`}
                className="sticky top-0 z-[1] flex items-center justify-between border-b border-border bg-muted/80 px-2.5 py-1 text-3xs font-semibold tracking-wider text-muted-foreground uppercase backdrop-blur"
                data-testid="factory-view-floor-roster-storey"
              >
                {STOREY_LABEL[g.id]}
                <span className="tabular-nums">{g.agents.length}</span>
              </h3>
            )}
            <ul className="divide-y divide-border/60">
              {g.agents.map((agent) => {
                const card = agentCard(agent, now);
                const shown = cards && hover.key === agent.key && rect;
                const cardId = `${ids}-${agent.key.replace(/[^\w-]/g, "_")}`;
                return (
                  <li key={agent.key}>
                    <button
                      type="button"
                      className={cn(
                        "block w-full px-2.5 py-2 text-left outline-none hover:bg-muted/60 focus-visible:bg-muted/60 focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset",
                        !cards && "min-h-12 px-3",
                      )}
                      onClick={() => {
                        if (!cards) setOpen(false);
                        onActivate(agent);
                      }}
                      onMouseEnter={(e) => show(agent.key, e.currentTarget)}
                      onMouseLeave={hover.leave}
                      onFocus={(e) => show(agent.key, e.currentTarget)}
                      onBlur={hover.leave}
                      aria-expanded={Boolean(shown)}
                      aria-controls={shown ? cardId : undefined}
                      data-testid="factory-view-floor-roster-row"
                      data-agent={agent.key}
                    >
                      <span className="flex items-center gap-1.5 text-xs">
                        <span
                          className={cn("size-2 shrink-0 rounded-full", DOT[agent.status])}
                          aria-hidden
                        />
                        <span className="font-medium">{card.role}</span>
                        {card.refs && (
                          <span className="truncate text-muted-foreground">{card.refs}</span>
                        )}
                      </span>
                      {card.title && (
                        <span className="mt-0.5 block truncate text-xs">{card.title}</span>
                      )}
                      <span className="mt-0.5 block truncate text-2xs text-muted-foreground">
                        {card.step} · {card.status}
                      </span>
                      <span className="mt-0.5 flex min-w-0 items-center gap-1 text-2xs text-muted-foreground">
                        {agent.providerId && (
                          <ProviderMark provider={agent.providerId} className="size-3" />
                        )}
                        <span className="truncate">{card.model}</span>
                      </span>
                    </button>
                    {shown && (
                      <AgentCardView
                        id={cardId}
                        agent={agent}
                        card={card}
                        style={cardBeside(shown)}
                        onEnter={keep}
                        onLeave={hover.leave}
                        onOpenItem={onOpenItem(agent)}
                      />
                    )}
                  </li>
                );
              })}
            </ul>
          </section>
        ))}
      </div>
    );
  }
}
