import type { AutonomyLevel } from "@agent-rishi/contracts";
import { Check, ClipboardList } from "lucide-react";
import { useId } from "react";
import { useTapTooltip } from "@/components/common/tap-tooltip";
import { AUTONOMY, AUTONOMY_LEVELS } from "@/components/thread/autonomy";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import { TRIGGER_CLASS } from "./model-picker/trigger";

/** Why Plan can't be used: the chosen provider doesn't report `capabilities.planMode`. */
export interface PlanUnavailable {
  /** The provider's name, as its runner info gives it (`ProviderInfo.displayName`). */
  provider: string;
  /** Plan was chosen before this provider was: it is off here, not forgotten. */
  wasOn: boolean;
  /** Another provider can still be picked (the New session draft), and Plan comes back there. */
  canSwitch?: boolean;
}

/** The reason a disabled Plan gives, naming the provider. */
function planUnavailableReason({ provider, wasOn, canSwitch }: PlanUnavailable): string {
  const cant = `${provider} can't plan first.`;
  if (wasOn) {
    return canSwitch
      ? `Plan mode is off: ${cant} It turns back on when you pick a provider that can plan.`
      : `Plan mode is off: ${cant}`;
  }
  return canSwitch ? `${cant} Pick a provider that can plan to use it.` : cant;
}

/**
 * Plan mode on or off: the agent explores and proposes a plan, and edits only once the plan is
 * approved. On a provider without `capabilities.planMode` it stays in place, disabled, and says
 * why (`unavailable`): on hover, keyboard focus, click or tap, and to assistive tech.
 */
export function PlanToggle({
  value,
  onChange,
  disabled,
  unavailable,
}: {
  value: boolean;
  onChange: (on: boolean) => void;
  disabled?: boolean;
  unavailable?: PlanUnavailable;
}) {
  if (unavailable) return <PlanUnavailableToggle {...unavailable} />;
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          variant="ghost"
          size="sm"
          className={cn(TRIGGER_CLASS, value && "bg-primary/10 text-primary hover:text-primary")}
          aria-label="Plan mode"
          aria-pressed={value}
          disabled={disabled}
          onClick={() => onChange(!value)}
        >
          <ClipboardList className="size-3.5" />
          Plan
        </Button>
      </TooltipTrigger>
      <TooltipContent className="max-w-64">
        {value
          ? "Plan mode is on: the agent plans without editing, and starts once you approve the plan."
          : "Plan first: the agent explores and proposes a plan before it changes anything."}
      </TooltipContent>
    </Tooltip>
  );
}

/**
 * Plan where the provider can't plan: never pressed, nothing to toggle. A click or a tap opens
 * the reason (the tooltip primitive ignores touch), and the reason is the button's description.
 * Plan chosen before shows struck through: it is off for this provider.
 */
function PlanUnavailableToggle(unavailable: PlanUnavailable) {
  const tip = useTapTooltip();
  const reasonId = useId();
  const reason = planUnavailableReason(unavailable);
  return (
    <>
      <Tooltip {...tip.root}>
        <TooltipTrigger asChild>
          <Button
            variant="ghost"
            size="sm"
            className={cn(
              TRIGGER_CLASS,
              "cursor-not-allowed opacity-50 hover:text-muted-foreground",
            )}
            aria-label="Plan mode"
            aria-pressed={false}
            aria-disabled
            aria-describedby={reasonId}
            {...tip.trigger}
          >
            <ClipboardList className="size-3.5" />
            <span className={cn(unavailable.wasOn && "line-through")}>Plan</span>
          </Button>
        </TooltipTrigger>
        <TooltipContent className="max-w-64">{reason}</TooltipContent>
      </Tooltip>
      <span id={reasonId} className="sr-only">
        {reason}
      </span>
    </>
  );
}

/**
 * Permissions picker (§11.2): Read-only, Supervised, Auto or Full, one plain line each.
 * Read-only is offered only when the provider enforces it (`readOnlySupported`). Provider,
 * model and effort live in `model-picker/`.
 */
export function AutonomyPicker({
  value,
  onChange,
  readOnlySupported = true,
  heading = "Permissions for this session",
  disabled,
}: {
  value: AutonomyLevel;
  onChange: (v: AutonomyLevel) => void;
  /** False when the session's provider cannot enforce Read-only. */
  readOnlySupported?: boolean;
  heading?: string;
  disabled?: boolean;
}) {
  const a = AUTONOMY[value];
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="ghost"
          size="sm"
          className={TRIGGER_CLASS}
          aria-label="Permissions"
          disabled={disabled}
        >
          <a.icon className={cn("size-3.5", a.tone)} />
          {a.short}
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-80" data-testid="permissions-menu">
        <DropdownMenuLabel className="text-2xs">{heading}</DropdownMenuLabel>
        {AUTONOMY_LEVELS.map((level) => {
          const o = AUTONOMY[level];
          const unavailable = level === "read_only" && !readOnlySupported;
          return (
            <DropdownMenuItem
              key={level}
              disabled={unavailable}
              onSelect={() => onChange(level)}
              className="items-start py-1.5"
            >
              <o.icon className={cn("mt-0.5 size-4", o.tone)} />
              <span className="min-w-0 flex-1">
                <span className="block text-[13px]">{o.label}</span>
                <span className="block text-2xs text-muted-foreground">
                  {unavailable ? "This provider can't enforce read-only." : o.description}
                </span>
              </span>
              {level === value && <Check className="mt-0.5 size-3.5" />}
            </DropdownMenuItem>
          );
        })}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
