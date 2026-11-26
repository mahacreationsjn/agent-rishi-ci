import { DEFAULT_CHECK_ROUNDS, type ProjectCheck } from "@agent-rishi/contracts";
import { ListChecks } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { cn } from "@/lib/utils";
import { TRIGGER_CLASS } from "./model-picker/trigger";

/** Round caps offered in the menu (the API takes 1 to 10). */
const ROUND_CHOICES = [1, 2, 3, 5, 10];

/** The loop setting the toggle edits. */
export interface ChecksLoopValue {
  untilPass: boolean;
  maxRounds: number;
}

/**
 * "Keep going until checks pass" (§9 Project checks): after each turn Agent Rishi runs the project's
 * checks and sends failures back to the agent, up to a number of rounds. Shown only when there
 * are checks to run: the project's (New session) or the session's frozen ones (composer).
 */
export function ChecksToggle({
  checks,
  value,
  onChange,
  disabled,
}: {
  checks: ProjectCheck[];
  value: ChecksLoopValue;
  onChange: (next: ChecksLoopValue) => void;
  disabled?: boolean;
}) {
  const on = value.untilPass;
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="ghost"
          size="sm"
          className={cn(TRIGGER_CLASS, on && "bg-primary/10 text-primary hover:text-primary")}
          aria-label="Keep going until checks pass"
          aria-pressed={on}
          disabled={disabled}
        >
          <ListChecks className="size-3.5" />
          Checks
          {on && <span className="tabular-nums opacity-80">×{value.maxRounds}</span>}
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-80" data-testid="checks-menu">
        <DropdownMenuCheckboxItem
          checked={on}
          onCheckedChange={(checked) => onChange({ ...value, untilPass: checked === true })}
          onSelect={(e) => e.preventDefault()}
          className="items-start py-1.5"
        >
          <span className="min-w-0 flex-1">
            <span className="block text-[13px]">Keep going until checks pass</span>
            <span className="block text-2xs text-muted-foreground">
              After each turn Agent Rishi runs the checks and sends failures back to the agent.
            </span>
          </span>
        </DropdownMenuCheckboxItem>
        <DropdownMenuSeparator />
        <DropdownMenuLabel className="text-2xs">At most this many rounds</DropdownMenuLabel>
        <DropdownMenuRadioGroup
          value={String(value.maxRounds)}
          onValueChange={(v) => onChange({ ...value, maxRounds: Number(v) })}
        >
          {ROUND_CHOICES.map((n) => (
            <DropdownMenuRadioItem
              key={n}
              value={String(n)}
              onSelect={(e) => e.preventDefault()}
              className="text-[13px]"
            >
              {n} {n === 1 ? "round" : "rounds"}
              {n === DEFAULT_CHECK_ROUNDS && (
                <span className="ml-auto text-2xs text-muted-foreground">default</span>
              )}
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
        <DropdownMenuSeparator />
        <DropdownMenuLabel className="text-2xs">The project's checks</DropdownMenuLabel>
        <ul className="space-y-0.5 px-2 pb-1.5">
          {checks.map((c) => (
            <li key={c.command} className="truncate font-mono text-[11.5px] text-muted-foreground">
              {c.command}
            </li>
          ))}
        </ul>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
