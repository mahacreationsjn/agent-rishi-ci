import type { ModelInfo, ReasoningEffort } from "@agent-rishi/contracts";
import { findOption, optionValues } from "../acp/config";
import type { AcpSessionSetup } from "../acp/protocol";
import { DEFAULT_MODEL_ID } from "../util/model";

/** Antigravity CLI's effort option and its values ("Extra" is `xhigh`; there is no `max`). */
export const AGY_EFFORT_OPTION = "thought_level";
const EFFORT_VALUES: Partial<Record<ReasoningEffort, string>> = {
  minimal: "low",
  low: "low",
  medium: "medium",
  high: "high",
  xhigh: "xhigh",
  max: "xhigh",
};
export const AGY_EFFORT = { option: AGY_EFFORT_OPTION, values: EFFORT_VALUES };

const EFFORTS: readonly ReasoningEffort[] = ["low", "medium", "high", "xhigh"];

/** "Default" leaves the choice to Antigravity CLI's own setting. */
function defaultModel(efforts: ReasoningEffort[]): ModelInfo {
  return {
    id: DEFAULT_MODEL_ID,
    label: "Default",
    description: "The model selected in Antigravity CLI (its own setting)",
    efforts,
    isDefault: true,
  };
}

/** Until a session has listed the account's models: Default only. */
export function fallbackAgyModels(): ModelInfo[] {
  return [defaultModel([...EFFORTS])];
}

/** The efforts the session's `thought_level` option offers, as Agent Rishi efforts. */
function effortsOf(setup: Pick<AcpSessionSetup, "configOptions">): ReasoningEffort[] {
  const option = findOption(setup.configOptions, AGY_EFFORT_OPTION);
  if (!option) return [];
  const values = new Set(optionValues(option).map((v) => v.value));
  return EFFORTS.filter((e) => values.has(e));
}

/**
 * The models a session reports (its `model` option: one entry per model, effort set apart by
 * `thought_level`), after Default. Every model offers the efforts the session lists.
 */
export function agyModelInfos(
  setup: Pick<AcpSessionSetup, "configOptions">,
  models: readonly { id: string; name?: string; description?: string }[],
): ModelInfo[] {
  const efforts = effortsOf(setup);
  const seen = new Set<string>();
  const out: ModelInfo[] = [defaultModel(efforts)];
  for (const m of models) {
    if (!m.id || m.id === DEFAULT_MODEL_ID || seen.has(m.id)) continue;
    seen.add(m.id);
    out.push({
      id: m.id,
      label: m.name || m.id,
      ...(m.description ? { description: m.description } : {}),
      efforts: [...efforts],
    });
  }
  return out;
}
