import {
  type AutonomyLevel,
  type ConflictRecord,
  DEFAULT_CHECK_ROUNDS,
  type ProviderInfo,
  type ReasoningEffort,
  type StartSessionRequestInit,
  type StartWorkResult,
  type UserInputInit,
} from "@agent-rishi/contracts";

/**
 * The New session draft (§13): a session view whose first send starts the session. These are
 * its pure rules: the defaults it starts from and the start request it sends.
 */

/** Conflicts not persisted by the server (no `conflictId`) are retried with a fresh start. */
export const LOCAL_CONFLICT_PREFIX = "local:";

/** What the user picked in the draft; `null` means "the default". */
export interface DraftChoice {
  provider: string | null;
  model: string | null;
  effort: ReasoningEffort | null;
  autonomy: AutonomyLevel | null;
  /**
   * Start in plan mode: the user's choice, kept across provider switches, but sent only when the
   * provider reports `capabilities.planMode`.
   */
  planMode: boolean;
  /**
   * Keep going until checks pass (§9 Project checks); offered only when the project has checks.
   * Absent on drafts saved before it existed: off.
   */
  untilChecksPass?: boolean;
  /** Automatic rounds for `untilChecksPass`; absent: the default. */
  checkRounds?: number;
}

export const emptyChoice: DraftChoice = {
  provider: null,
  model: null,
  effort: null,
  autonomy: null,
  planMode: false,
};

/** A default provider with the model and effort that go with it (model ids are per provider). */
export interface DefaultAgent {
  /** A provider id; `auto` (Settings) or null names none. */
  provider: string | null;
  model: string | null;
  effort: ReasoningEffort | null;
}

/** Where the defaults come from: the runner's providers, the project and Settings. */
export interface DraftDefaults {
  providers: ProviderInfo[];
  project:
    | {
        defaultProvider: string | null;
        defaultModel: string | null;
        defaultEffort: ReasoningEffort | null;
        autonomy: AutonomyLevel | null;
        /** False when the project folder isn't a git repository (`Project.isGitRepo`). */
        isGitRepo?: boolean;
      }
    | undefined;
  /** Settings → Providers → Agent sessions. */
  agent: DefaultAgent | null;
  /** Settings → Autonomy default. */
  defaultAutonomy: AutonomyLevel;
}

/** The draft's choice with its defaults filled in: what the pickers show and the start sends. */
export interface ResolvedDraft {
  provider: ProviderInfo | undefined;
  model: string | null;
  /** Sent only when the provider reports `capabilities.reasoningEffort`. */
  effort: ReasoningEffort | null;
  autonomy: AutonomyLevel;
  /** On only where the provider supports plan mode. */
  planMode: boolean;
  /** Off at Read-only, where the agent can't fix anything. */
  untilChecksPass: boolean;
  checkRounds: number;
  /**
   * Where the session runs (§9): its own worktree, or the project folder itself when the folder
   * isn't a git repository (no worktree can be made there).
   */
  workspace: "worktree" | "repo_root";
}

/** Why a project whose folder isn't a git repository gets no worktree (as the server says). */
export const NOT_A_REPO_REASON = "Not a git repository: sessions run in the project folder";

/**
 * Fill in the defaults, so the pickers show what the first send will start:
 * - provider: the one picked, else the project's default, else Settings → Agent sessions, else
 *   the first ready provider (a provider the runner doesn't list is skipped);
 * - model and effort: what was picked for that provider (a custom model id included), else the
 *   first default naming that provider and a model or effort (the project's, then Settings'),
 *   else the provider's default model and the model's own effort. A default for another provider
 *   never applies: its model id means nothing there;
 * - autonomy: the one picked, else the project's, else the Settings default;
 * - keep going until checks pass: as picked, but never at Read-only;
 * - workspace: a new worktree, or the project folder when it isn't a git repository.
 */
export function resolveDraftChoice(choice: DraftChoice, defaults: DraftDefaults): ResolvedDraft {
  const { providers, project } = defaults;
  const known = (id: string | null | undefined) =>
    id && providers.some((p) => p.id === id) ? id : null;
  const providerId =
    known(choice.provider) ??
    known(project?.defaultProvider) ??
    known(defaults.agent?.provider) ??
    providers[0]?.id ??
    null;
  const provider = providers.find((p) => p.id === providerId);
  // What was picked for another provider (one that is gone now) doesn't carry over.
  const mine = provider !== undefined && (choice.provider ?? provider.id) === provider.id;
  const projectAgent: DefaultAgent | null = project
    ? {
        provider: project.defaultProvider,
        model: project.defaultModel,
        effort: project.defaultEffort,
      }
    : null;
  const preset = [projectAgent, defaults.agent].find(
    (d) => d && d.provider === provider?.id && (d.model !== null || d.effort !== null),
  );
  const fallback = provider?.models.find((m) => m.isDefault) ?? provider?.models[0];
  const autonomy = choice.autonomy ?? project?.autonomy ?? defaults.defaultAutonomy;
  return {
    provider,
    model: (mine ? choice.model : null) ?? preset?.model ?? fallback?.id ?? null,
    effort: provider?.capabilities.reasoningEffort
      ? ((mine ? choice.effort : null) ?? preset?.effort ?? null)
      : null,
    autonomy,
    planMode: choice.planMode && (provider?.capabilities.planMode ?? false),
    untilChecksPass: (choice.untilChecksPass ?? false) && autonomy !== "read_only",
    checkRounds: choice.checkRounds ?? DEFAULT_CHECK_ROUNDS,
    workspace: project?.isGitRepo === false ? "repo_root" : "worktree",
  };
}

/**
 * The choice after the model picker changed provider, model or effort. Plan stays as chosen: on
 * a provider without plan mode it is off (`resolveDraftChoice`, so the start request leaves it
 * out) and the Plan control says so, and picking a provider that can plan turns it back on.
 */
export function pickModel(
  choice: DraftChoice,
  next: { provider: string; model: string | null; effort: ReasoningEffort | null },
): DraftChoice {
  return { ...choice, ...next };
}

/** `POST /api/sessions` for the draft's first message. */
export function buildStartRequest(
  projectId: string,
  input: UserInputInit,
  resolved: ResolvedDraft,
  workKey: string,
): StartSessionRequestInit {
  const key = workKey.trim();
  return {
    projectId,
    input,
    autonomy: resolved.autonomy,
    ...(resolved.planMode ? { planMode: true } : {}),
    // The server freezes the project's checks; without any it ignores these.
    ...(resolved.untilChecksPass
      ? { untilChecksPass: true, checkRounds: resolved.checkRounds }
      : {}),
    ...(resolved.provider ? { provider: resolved.provider.id } : {}),
    ...(resolved.model ? { model: resolved.model } : {}),
    ...(resolved.effort ? { effort: resolved.effort } : {}),
    ...(key ? { workKey: key } : {}),
    // A git project leaves it to the server (a new worktree); a folder that isn't one says so.
    ...(resolved.workspace === "repo_root" ? { workspace: { mode: "repo_root" as const } } : {}),
  };
}

/**
 * The purpose a start takes from its text, as the server derives it: the first line that isn't
 * blank, shortened to 120 characters. `null` for a draft without text.
 */
export function draftPurpose(text: string): string | null {
  const line = text
    .split(/\r?\n/)
    .find((l) => l.trim())
    ?.trim();
  if (!line) return null;
  return line.length > 120 ? `${line.slice(0, 117)}...` : line;
}

/**
 * A conflict the server did not persist (no `conflictId`), shown and resolved like a persisted
 * one: its decisions retry the start request.
 */
export function localConflict(
  request: StartSessionRequestInit,
  result: Extract<StartWorkResult, { status: "conflict" }>,
  now = new Date(),
): ConflictRecord {
  return {
    id: `${LOCAL_CONFLICT_PREFIX}${now.getTime()}`,
    projectId: request.projectId,
    request: {
      purpose: draftPurpose(request.input?.text ?? "") ?? "New session",
      workKey: request.workKey || result.existing[0]?.workKey || "request:new",
      startedBy: { kind: "user" },
    },
    existing: result.existing,
    start: JSON.parse(JSON.stringify(request)),
    status: "open",
    resolution: null,
    outcome: null,
    createdAt: now.toISOString(),
    resolvedAt: null,
  };
}
