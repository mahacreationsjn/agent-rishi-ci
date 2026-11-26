import { Box, LayoutGrid, type LucideIcon } from "lucide-react";
import type { KeyboardEvent } from "react";
import { cn } from "@/lib/utils";
import type { ViewMode, ViewModeId } from "./view-mode";

const OPTIONS: { id: ViewModeId; label: string; title: string; icon: LucideIcon }[] = [
  { id: "board", label: "Board", title: "The pipeline as stages and cards", icon: LayoutGrid },
  {
    id: "floor",
    label: "Floor",
    title: "Factory floor: a 3D workshop with every agent at its station",
    icon: Box,
  },
];

/**
 * The Factory view's mode toggle (#420, #476): Board | Floor as one radio group. Arrow keys
 * move between the modes, like any radio group; only the chosen one is a Tab stop.
 */
export function ViewModeToggle({ view }: { view: ViewMode }) {
  const pick = (id: ViewModeId, focus: HTMLElement | null) => {
    view.set(id);
    focus?.querySelector<HTMLElement>(`[data-mode="${id}"]`)?.focus();
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
    const at = OPTIONS.findIndex((o) => o.id === view.mode);
    const next = OPTIONS[(at + step + OPTIONS.length) % OPTIONS.length] as (typeof OPTIONS)[number];
    pick(next.id, e.currentTarget);
  };
  return (
    <div
      role="radiogroup"
      aria-label="Factory view mode"
      className="inline-flex items-center rounded-md border border-border bg-muted/40 p-0.5"
      onKeyDown={onKeyDown}
      data-testid="factory-view-mode"
    >
      {OPTIONS.map((o) => {
        const on = o.id === view.mode;
        const Icon = o.icon;
        return (
          // biome-ignore lint/a11y/useSemanticElements: a segmented control with roving focus.
          <button
            key={o.id}
            type="button"
            role="radio"
            aria-checked={on}
            tabIndex={on ? 0 : -1}
            title={o.title}
            onClick={() => view.set(o.id)}
            data-mode={o.id}
            data-testid={`factory-view-mode-${o.id}`}
            className={cn(
              "inline-flex h-7 items-center gap-1.5 rounded-[5px] px-2 text-xs font-medium text-muted-foreground transition-colors outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring [&_svg]:size-3.5",
              on && "bg-background text-foreground shadow-sm",
            )}
          >
            <Icon aria-hidden />
            {o.label}
          </button>
        );
      })}
    </div>
  );
}
