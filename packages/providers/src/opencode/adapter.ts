import type {
  ModelInfo,
  ProviderCapabilities,
  ProviderStatus,
  SessionOptions,
} from "@agent-rishi/contracts";
import type { ProviderAdapter, ProviderSession, RefreshModelsOptions } from "../adapter";
import { executableFingerprint, ModelFreshness } from "../freshness";
import { ModelCatalog } from "../models";
import type { ResolvedCommand } from "../util/exec";
import { ensureLocated } from "../util/locate";
import type { UtilityModel } from "../utility";
import { detectOpenCode, OPENCODE_MIN_VERSION } from "./detect";
import { locateOpenCode } from "./locate";
import { fallbackOpenCodeModels, modelEfforts } from "./models";
import { OpenCodeUtilityModel } from "./one-shot";
import { guardPluginDir } from "./plugin";
import { type OpenCodeProbe, probeOpenCode } from "./probe";
import { OpenCodeProjectModels } from "./project-models";
import type { CatalogPolling } from "./ready";
import { OpenCodeSession } from "./session";

export const OPENCODE_PROVIDER_ID = "opencode";

/**
 * Honest flags (Principle 5). Steering is OpenCode's `delivery: "steer"`; approvals and the
 * read-only level go through OpenCode's permission requests, decided by Agent Rishi's policy for
 * every call (so autonomy changes apply live); subagents are child sessions. Skills and custom
 * commands are OpenCode's own lists, reported for the `/` menu: `/<command>` runs the command
 * and `/<skill>` attaches the skill to the prompt (`commands.ts`). Not wired up yet: rollback
 * (OpenCode's revert), fork and plan mode (OpenCode's `plan` agent).
 */
const capabilities: ProviderCapabilities = {
  resume: true,
  steer: true,
  interrupt: true,
  approvals: true,
  userQuestions: true,
  subagents: true,
  rollback: false,
  fork: false,
  images: true,
  planMode: false,
  reasoningEffort: true,
  mcp: true,
  skills: true,
  liveAutonomy: true,
  readOnly: true,
  compact: true,
  projectModels: true,
};

export interface OpenCodeAdapterOptions {
  executable?: ResolvedCommand;
  /** Max time for a probe (model discovery, detection), server start-up included. */
  probeTimeoutMs?: number;
  /** Skip the env-guard plugin (tests with a fake server). */
  noGuardPlugin?: boolean;
  /**
   * How the provider and model lists are polled until they settle (`readProviderCatalog`), for
   * probes and the utility model; tests with a fake server shorten the settle window.
   */
  catalog?: CatalogPolling;
}

/** OpenCode through a private `opencode serve` per session, over its v2 HTTP API (§7.2). */
export class OpenCodeAdapter implements ProviderAdapter {
  readonly id = OPENCODE_PROVIDER_ID;
  readonly displayName = "OpenCode";
  private readonly catalog = new ModelCatalog(fallbackOpenCodeModels());
  private listed = false;
  private readonly freshness = new ModelFreshness();
  private probing: Promise<OpenCodeProbe> | undefined;
  /** Lists made with a project's own config (#643), per project. */
  private readonly projectLists = new OpenCodeProjectModels({
    probe: async (exe, projectConfig) =>
      (await probeOpenCode(exe, this.probeOptions(projectConfig))).models,
    global: () => this.catalog.list(),
  });

  constructor(private readonly options: OpenCodeAdapterOptions = {}) {}

  /** `opencode`, looked up every time: the runner outlives updates and reinstalls. */
  private executable(): ResolvedCommand | undefined {
    return this.options.executable ?? locateOpenCode();
  }

  /**
   * Before a runner's first session or model list: check the copies once (`ensureLocated`),
   * so `executable()` skips an old or broken one although no detection has run yet.
   */
  private async located(): Promise<void> {
    if (!this.options.executable) await ensureLocated("opencode", OPENCODE_MIN_VERSION);
  }

  /**
   * Finds a working copy (validating each one, so a broken shim never wins), then probes it
   * for providers; the probe also refreshes the models.
   */
  detect(): Promise<ProviderStatus> {
    return detectOpenCode({
      ...(this.options.executable ? { executable: this.options.executable } : {}),
      probe: (exe) => this.probe(exe),
    });
  }

  capabilities(): ProviderCapabilities {
    return { ...capabilities };
  }

  models(): ModelInfo[] {
    return this.catalog.list();
  }

  onModelsChanged(listener: () => void): () => void {
    return this.catalog.subscribe(listener);
  }

  /**
   * Load the model list from a short-lived private server (`GET /api/model`; no session, no
   * model call). Shares a probe already running (detection). With `maxAgeMs`, skipped while
   * the list is recent and `opencode` has not changed. Never throws.
   */
  async refreshModels(opts: RefreshModelsOptions = {}): Promise<void> {
    await this.located();
    const exe = this.executable();
    if (!exe) return;
    if (
      opts.maxAgeMs !== undefined &&
      !this.probing &&
      this.freshness.isFresh(executableFingerprint(exe), opts.maxAgeMs)
    ) {
      return;
    }
    await this.probe(exe).catch(() => undefined);
  }

  /**
   * A project's models: OpenCode's list with the project's own `opencode.json` (or `.opencode/`
   * config) layered in, which neither the temp-folder probe nor a worktree sees (#643).
   */
  async projectModels(projectDir: string, opts: { refresh?: boolean } = {}) {
    await this.located();
    return this.projectLists.list(this.executable(), projectDir, opts);
  }

  async openSession(opts: SessionOptions): Promise<ProviderSession> {
    await this.located();
    const executable = this.executable();
    if (!executable) throw new Error("OpenCode is not installed (no `opencode` on PATH)");
    // The project's own list when one was made: it holds the models its config adds.
    const listFor = () => this.projectLists.cached(opts.projectDir) ?? this.catalog.list();
    const efforts = (model: string | undefined) => {
      const list = listFor();
      // A model OpenCode doesn't list (a custom id) has no known variants, and OpenCode fails
      // the turn on a variant the model lacks, so none is sent; before discovery, efforts pass.
      return (
        modelEfforts(list, model ?? list.find((m) => m.isDefault)?.id) ??
        (this.listed ? [] : undefined)
      );
    };
    const session = new OpenCodeSession(opts, {
      executable,
      ...(this.options.noGuardPlugin ? {} : { pluginDir: guardPluginDir() }),
      modelEfforts: efforts,
      contextWindow: (model) => {
        const list = listFor();
        const id = model ?? list.find((m) => m.isDefault)?.id;
        return list.find((m) => m.id === id)?.contextWindow;
      },
    });
    try {
      await session.start();
    } catch (error) {
      await session.close();
      throw error;
    }
    return session;
  }

  utilityModel(): UtilityModel {
    return new OpenCodeUtilityModel(() => this.executable(), this.options.catalog);
  }

  private probeOptions(projectConfig?: Record<string, unknown>) {
    return {
      timeoutMs: this.options.probeTimeoutMs,
      ...(projectConfig ? { projectConfig } : {}),
      ...(this.options.catalog ? { catalog: this.options.catalog } : {}),
    };
  }

  /** One probe at a time; its models replace the catalog. Rejects on failure. */
  private probe(exe: ResolvedCommand): Promise<OpenCodeProbe> {
    this.probing ??= probeOpenCode(exe, this.probeOptions())
      .then(
        (result) => {
          if (result.models.length) this.setModels(result.models, exe);
          else this.discoveryFailed("OpenCode listed no models.");
          return result;
        },
        (error) => {
          const reason = (error instanceof Error ? error.message : String(error)).slice(0, 200);
          this.discoveryFailed(`OpenCode's model list could not be loaded: ${reason}`);
          throw error;
        },
      )
      .finally(() => {
        this.probing = undefined;
      });
    return this.probing;
  }

  private setModels(models: ModelInfo[], from: ResolvedCommand): void {
    this.listed = true;
    this.freshness.confirm(executableFingerprint(from));
    this.catalog.set(models);
    // A sign-in or a new provider changes every project's list too.
    this.projectLists.clear();
  }

  /** Keep the last real list; without one, say why only the configured default is offered. */
  private discoveryFailed(note: string): void {
    if (!this.listed) this.catalog.set(fallbackOpenCodeModels(note));
  }
}
