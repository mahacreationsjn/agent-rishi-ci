import { CircleHelp } from "lucide-react";
import type { ReactNode } from "react";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import { useTapTooltip } from "./tap-tooltip";

/**
 * Explains a term in a sentence or two: a small "?" next to it, or the term itself with a dotted
 * underline (`term`) where there is no room for an icon. The tooltip opens on mouse hover and
 * on keyboard focus like any other; a click or a tap opens it too, and a second tap closes it
 * (the tooltip primitive ignores touch, so phones and tablets rely on the tap). Escape, or a
 * tap anywhere else, closes it.
 */
export function InfoHint({
  label,
  term,
  children,
  side = "top",
  className,
}: {
  /** The term it explains, read out as "About <label>". */
  label: string;
  /** Show this (the term) as the trigger, underlined, instead of the "?" icon. */
  term?: ReactNode;
  children: ReactNode;
  side?: "top" | "right" | "bottom" | "left";
  className?: string;
}) {
  const tip = useTapTooltip();
  return (
    <Tooltip {...tip.root}>
      <TooltipTrigger asChild>
        <button
          type="button"
          aria-label={term ? undefined : `About ${label}`}
          data-testid="info-hint"
          {...tip.trigger}
          className={cn(
            "cursor-help rounded-sm transition-colors focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:outline-none",
            term
              ? "underline decoration-muted-foreground/50 decoration-dotted underline-offset-[3px] hover:decoration-foreground"
              : "relative inline-flex size-3.5 shrink-0 items-center justify-center rounded-full align-middle text-muted-foreground/70 after:absolute after:-inset-1.5 hover:text-foreground focus-visible:text-foreground pointer-coarse:after:-inset-3 [&_svg]:size-3",
            className,
          )}
        >
          {term ?? <CircleHelp aria-hidden />}
        </button>
      </TooltipTrigger>
      <TooltipContent side={side} className="max-w-64 text-left leading-snug font-normal">
        {children}
      </TooltipContent>
    </Tooltip>
  );
}
