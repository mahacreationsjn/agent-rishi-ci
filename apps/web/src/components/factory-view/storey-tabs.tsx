import type { KeyboardEvent } from "react";
import { cn } from "@/lib/utils";
import type { StoreyFocus, StoreyTab } from "./scene/storeys";

/**
 * Floor mode's storey tabs (#476), beside the mode toggle in a dark factory: Workshop, Lookout
 * and Both, each with its agent count and a pink dot when someone there waits on a person.
 * One radio group: arrow keys move between them, and only the chosen one is a Tab stop.
 */
export function StoreyTabs({
  tabs,
  focus,
  onFocus,
}: {
  tabs: readonly StoreyTab[];
  focus: StoreyFocus;
  onFocus: (focus: StoreyFocus) => void;
}) {
  if (tabs.length === 0) return null;
  const pick = (id: StoreyFocus, group: HTMLElement | null) => {
    onFocus(id);
    group?.querySelector<HTMLElement>(`[data-storey="${id}"]`)?.focus();
  };
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const step =
      e.key === "ArrowRight" || e.key === "ArrowDown"
        ? 1
        : e.key === "ArrowLeft" || e.key === "ArrowUp"
          ? -1
          : 0;
    if (!step) return;
    e.preventDefault();
    const at = tabs.findIndex((t) => t.id === focus);
    const next = tabs[(at + step + tabs.length) % tabs.length] as StoreyTab;
    pick(next.id, e.currentTarget);
  };
  return (
    <div
      role="radiogroup"
      aria-label="Storey"
      className="inline-flex items-center rounded-md border border-border bg-muted/40 p-0.5"
      onKeyDown={onKeyDown}
      data-testid="factory-view-storeys"
    >
      {tabs.map((t) => {
        const on = t.id === focus;
        return (
          // biome-ignore lint/a11y/useSemanticElements: a segmented control with roving focus.
          <button
            key={t.id}
            type="button"
            role="radio"
            aria-checked={on}
            aria-label={`${t.label}: ${t.count} ${t.count === 1 ? "agent" : "agents"}${t.waiting ? ", someone waits on you" : ""}`}
            tabIndex={on ? 0 : -1}
            onClick={() => onFocus(t.id)}
            data-storey={t.id}
            data-testid={`factory-view-storey-${t.id}`}
            className={cn(
              "inline-flex h-7 items-center gap-1.5 rounded-[5px] px-2 text-xs font-medium text-muted-foreground transition-colors outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring",
              on && "bg-background text-foreground shadow-sm",
            )}
          >
            {t.label}
            <span className="rounded-full bg-muted px-1.5 text-2xs tabular-nums">{t.count}</span>
            {t.waiting && (
              <span
                aria-hidden
                className="size-1.5 rounded-full bg-status-waiting"
                data-testid="factory-view-storey-waiting"
              />
            )}
          </button>
        );
      })}
    </div>
  );
}
