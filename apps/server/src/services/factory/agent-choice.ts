import type {
  FactoryItem,
  FactoryTuning,
  ModelInfo,
  Project,
  Session,
} from "@agent-rishi/contracts";
import { earliestUntil, untilText } from "./availability";
import type { FactoryContext } from "./context";

/**
 * Model routing (§10.1, Provider availability): which provider and model start a builder or the
 * scout. Feature and bug builds use `builderProvider`/`builderModel`; docs builds use
 * `docsBuilderProvider`/`docsBuilderModel` when one is chosen; the scout and its area reviewers
 * use `scoutProvider`/`scoutModel`. Reviewers have their own choice (`reviewer-choice.ts`).
 */

/** The provider and model asked for; `auto`: the project's provider, else the agent role's. */
export interface AgentWanted {
  provider: string;
  /** Null: the provider's default. Applies only to a chosen provider, never to `auto`. */
  model: string | null;
}

/** Where a session starts: `auto` lets the session service pick, as it always has. */
export interface AgentChoice {
  provider: string;
  model: string | null;
}

/** No provider can take new work: the note to show while it waits. */
export interface AgentWait {
  waiting: string;
}

/** Who builds an item: docs on the docs builder when one is chosen, the rest on the builder. */
export function builderWanted(
  item: Pick<FactoryItem, "type">,
  tuning: Pick<
    FactoryTuning,
    "builderProvider" | "builderModel" | "docsBuilderProvider" | "docsBuilderModel"
  >,
): AgentWanted {
  if (item.type === "docs" && tuning.docsBuilderProvider) {
    return { provider: tuning.docsBuilderProvider, model: tuning.docsBuilderModel };
  }
  return { provider: tuning.builderProvider, model: tuning.builderModel };
}

/** Where the scout and its area reviewers run: what the settings ask, and where new ones start. */
export interface ScoutAgent {
  wanted: AgentWanted;
  choice: AgentChoice | AgentWait;
}

/** The scout's and its area reviewers' provider and model (`scoutProvider`, `scoutModel`). */
export function scoutAgent(
  ctx: FactoryContext,
  project: Project,
  tuning: Pick<FactoryTuning, "scoutProvider" | "scoutModel">,
): ScoutAgent {
  const wanted = { provider: tuning.scoutProvider, model: tuning.scoutModel };
  return { wanted, choice: chooseAgent(ctx, project, wanted, "scout") };
}

/**
 * The provider and model to start on: the wanted ones when that provider is available;
 * otherwise another available provider (the project's, then the agent default, then any), with
 * its default model. `auto` stays `auto` while every provider is available. Nothing available:
 * it waits ("Waiting: no build provider available until …", `what` naming the work).
 */
export function chooseAgent(
  ctx: FactoryContext,
  project: Project,
  wanted: AgentWanted,
  what: string,
): AgentChoice | AgentWait {
  const available = ctx.sessions.providers();
  const blocked = ctx.sessions.unavailable();
  if (blocked.length === 0) {
    return {
      provider: wanted.provider,
      model: wanted.provider === "auto" ? null : wanted.model,
    };
  }
  if (available.length === 0) {
    return {
      waiting: `Waiting: no ${what} provider available${untilText(earliestUntil(blocked))}`,
    };
  }
  if (wanted.provider !== "auto" && available.includes(wanted.provider)) {
    return { provider: wanted.provider, model: wanted.model };
  }
  const roleDefault = ctx.settings.get().providers.agent.provider;
  const order = [wanted.provider, project.defaultProvider, roleDefault, ...available];
  const provider = order.find((p): p is string => Boolean(p) && available.includes(p as string));
  return { provider: provider ?? (available[0] as string), model: null };
}

/**
 * Whether a long-lived scout or area reviewer session should be replaced by a fresh one before
 * its next round: the settings name a provider (not `auto`, which reuses any session as it always
 * has) and the session doesn't run where a new one would start, on another provider or, when a
 * model is set, another model (`modelMatches`, given the models its provider lists). A model left
 * to the provider's default matches any (sessions keep the default they resolved to). Compared
 * with the choice rather than the settings, so while the chosen provider is unavailable a session
 * on the fallback is kept instead of replaced each round.
 */
export function needsFreshSession(
  session: Pick<Session, "provider" | "model">,
  { wanted, choice }: ScoutAgent,
  models: readonly ModelInfo[],
): boolean {
  if (wanted.provider === "auto" || "waiting" in choice || choice.provider === "auto") return false;
  if (session.provider !== choice.provider) return true;
  return choice.model !== null && !modelMatches(models, choice.model, session.model);
}

/** The model id that stands for "the provider's default model", like no model at all. */
const DEFAULT_MODEL_ID = "default";

/** Lowercase words of an id or a name: `claude-opus-5-5` and `Opus 5.5` → `claude opus 5 5`. */
const words = (s: string) =>
  s
    .toLowerCase()
    .replace(/[\s_\-.]+/g, " ")
    .trim();

/**
 * Whether a session runs the model `chosen` names. A session's stored model doesn't stay the id
 * it started with: a provider that lists aliases (Claude Code's `haiku`) reports the full id once
 * the session starts (`claude-haiku-5-5`), and the session takes it. So it matches the chosen id
 * itself; the full id that alias runs today (`ModelInfo.resolvedId`); else, as the model picker
 * does, a versioned label the full id ends with ("Haiku 4.5" for `claude-haiku-4-5`); else, for
 * an alias without a version (before the provider's model list is known), a full id that names
 * it as one of its words. `default`, like no model, is the provider's default, which any matches.
 */
export function modelMatches(
  models: readonly ModelInfo[],
  chosen: string,
  actual: string | null,
): boolean {
  if (chosen === DEFAULT_MODEL_ID || actual === chosen) return true;
  if (!actual) return false;
  const entry = models.find((m) => m.id === chosen);
  if (entry?.resolvedId) return entry.resolvedId === actual;
  const id = words(actual);
  const label = words(entry?.label ?? "");
  if (/\d/.test(label) && (id === label || id.endsWith(` ${label}`))) return true;
  return !/\d/.test(chosen) && id.split(" ").includes(words(chosen));
}
