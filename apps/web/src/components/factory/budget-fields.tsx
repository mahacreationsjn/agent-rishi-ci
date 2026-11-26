import type { FactoryLimits } from "@agent-rishi/contracts";
import { useId } from "react";
import { Field } from "@/components/automations/form-bits";
import { NumberField } from "@/components/common/number-field";
import { Switch } from "@/components/ui/switch";

type Budget = FactoryLimits["dailyBudget"];

/** A budget with the amounts left empty removed (none set is no budget). */
function setBudget(budget: Budget, patch: Partial<Budget>): Budget {
  const next = { ...budget, ...patch };
  for (const k of ["usd", "tokens"] as const) if (!next[k]) delete next[k];
  return next;
}

/** One budget as a pair of fields: USD and tokens, either or both. */
function BudgetPair({
  label,
  budget,
  onChange,
  usdHelp,
  tokensHelp,
  usdPlaceholder,
  tokensPlaceholder,
}: {
  label: string;
  budget: Budget;
  onChange: (b: Budget) => void;
  usdHelp: string;
  tokensHelp: string;
  usdPlaceholder: string;
  tokensPlaceholder: string;
}) {
  const id = useId();
  return (
    <div className="grid gap-3 sm:grid-cols-2">
      <Field label={`${label} (USD)`} htmlFor={`${id}-usd`} help={usdHelp}>
        <NumberField
          id={`${id}-usd`}
          decimal
          optional
          min={0}
          value={budget.usd}
          placeholder={usdPlaceholder}
          onChange={(usd) => onChange(setBudget(budget, { usd: usd || undefined }))}
          className="text-[13px]"
        />
      </Field>
      <Field label={`${label} (tokens)`} htmlFor={`${id}-tok`} help={tokensHelp}>
        <NumberField
          id={`${id}-tok`}
          optional
          min={0}
          value={budget.tokens}
          placeholder={tokensPlaceholder}
          onChange={(tokens) => onChange(setBudget(budget, { tokens: tokens || undefined }))}
          className="text-[13px]"
        />
      </Field>
    </div>
  );
}

/**
 * The factory's spend limits (§10.1): the daily budget (required in factory modes), what counts
 * against it, and the optional per-item cap.
 */
export function BudgetFields({
  limits,
  onChange,
}: {
  limits: FactoryLimits;
  onChange: (l: FactoryLimits) => void;
}) {
  return (
    <>
      <BudgetPair
        label="Daily budget"
        budget={limits.dailyBudget}
        onChange={(dailyBudget) => onChange({ ...limits, dailyBudget })}
        usdHelp="The loop pauses until tomorrow when today's spend reaches it."
        tokensHelp="Optional, alongside USD."
        usdPlaceholder="e.g. 10"
        tokensPlaceholder="e.g. 5000000"
      />
      <div className="flex items-start gap-2.5 text-xs">
        <Switch
          checked={limits.budgetScope === "project"}
          aria-label="Count all project spend against the budget"
          onCheckedChange={(all) =>
            onChange({ ...limits, budgetScope: all ? "project" : "factory" })
          }
          className="mt-0.5"
        />
        <span>
          Count all spend in this project
          <span className="block text-3xs text-muted-foreground">
            Off: only the factory's own sessions (builders, reviewers, the scout, reverts) count.
          </span>
        </span>
      </div>
      <BudgetPair
        label="Per-item cap"
        budget={limits.itemBudget}
        onChange={(itemBudget) => onChange({ ...limits, itemBudget })}
        usdHelp="Optional. An item that spends this much stops and waits for you; a retry gives it the same again. Empty: no cap."
        tokensHelp="Optional, alongside USD."
        usdPlaceholder="No cap"
        tokensPlaceholder="No cap"
      />
    </>
  );
}
