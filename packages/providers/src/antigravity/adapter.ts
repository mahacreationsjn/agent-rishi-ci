import path from "node:path";
import type {
  ModelInfo,
  ProviderCapabilities,
  ProviderStatus,
  SessionOptions,
} from "@agent-rishi/contracts";
import { modeIds, modelsOf } from "../acp/config";
import { classifyAcpError } from "../acp/errors";
import type { AcpAgentSpec } from "../acp/extensions";
import type { AcpInitializeResult, AcpSessionSetup } from "../acp/protocol";
import { AcpSession } from "../acp/session";
import { type ProviderAdapter, type ProviderSession, ProviderSessionError } from "../adapter";
import { ModelCatalog } from "../models";
import type { ResolvedCommand } from "../util/exec";
import { findExecutable, type LocateOptions } from "../util/locate";
import {
  AGY_LOGIN_COMMAND,
  AGY_MIN_VERSION,
  AGY_UPGRADE_COMMAND,
  agyTooOldMessage,
  detectAgy,
  isSupportedAgyVersion,
} from "./detect";
import { agyExtensions } from "./extensions";
import { AGY_EFFORT, agyModelInfos, fallbackAgyModels } from "./models";
import { AGY_ACP_ARGS, type AgyProbe, probeAgy } from "./probe";
import { agyDir, writeAgySettings } from "./settings";
import { AGY_SUBAGENTS } from "./subagents";

export const ANTIGRAVITY_PROVIDER_ID = "antigravity";

/**
 * How Agent Rishi drives `agy acp`. No `authMethod`: sessions use the login the user already has.
 * Each session reads Agent Rishi's own settings (`--cli_dir_name`, `./settings`), with
 * `toolPermission: "strict"`, so Antigravity CLI asks before every edit, command and MCP tool,
 * whatever allow rules say, and Agent Rishi's policy decides each one (§11.2). Agent sessions run
 * in its `default` mode; it has no read-only mode, so read-only sessions stay in `default` and
 * the policy refuses edits and commands. Plan mode is its `plan` mode, whose plan becomes
 * Agent Rishi's plan approval (`./extensions`). Effort is its `thought_level` option. Steering is
 * another `session/prompt` during the running one, which Antigravity CLI refuses while it
 * waits for an approval or an answer (`waitRefusal`).
 */
export const ANTIGRAVITY_AGENT: AcpAgentSpec = {
  label: "Antigravity CLI",
  args: AGY_ACP_ARGS,
  // Its usage counts cached tokens apart: `totalTokens` is input + output + cached reads.
  inputExcludesCache: true,
  modes: { agent: "default", plan: "plan" },
  effort: AGY_EFFORT,
  steering: { waitRefusal: /waiting for a permission or question answer/i },
  inlineSubagents: AGY_SUBAGENTS,
};

/**
 * Honest flags (Principle 5). Approvals and the read-only level go through its permission
 * requests (strict settings), decided by Agent Rishi's policy for every call. Resume is
 * `session/load`; effort is `thought_level`; plan mode is its `plan` mode with Agent Rishi's plan
 * approval; its questions arrive as forms (`elicitation/create`) and become question cards;
 * steering is a prompt sent during the running one; subagents are cards with threads of their
 * own, fed by their tool call ids (`./subagents`); its `/` commands and skills come from
 * `available_commands_update` and run as a message starting with `/<name>`. Not wired up:
 * rollback and fork.
 * Images and MCP servers follow what the CLI reports in `initialize`.
 */
const BASE_CAPABILITIES: ProviderCapabilities = {
  resume: true,
  steer: true,
  interrupt: true,
  approvals: true,
  userQuestions: true,
  subagents: true,
  rollback: false,
  fork: false,
  images: true,
  planMode: true,
  reasoningEffort: true,
  mcp: true,
  skills: true,
  liveAutonomy: true,
  readOnly: true,
};

export interface AntigravityAdapterOptions {
  executable?: ResolvedCommand;
  /** Where to look for the CLI (tests); default PATH, then `~/.local/bin`. */
  locate?: LocateOptions;
  /** The home folder whose `~/.gemini/antigravity-cli` sessions use (tests). */
  home?: string;
  probeTimeoutMs?: number;
  startTimeoutMs?: number;
  interruptTimeoutMs?: number;
}

/** Antigravity CLI through its ACP server (`agy acp`), one process per session (§7.2). */
export class AntigravityAdapter implements ProviderAdapter {
  readonly id = ANTIGRAVITY_PROVIDER_ID;
  readonly displayName = "Antigravity CLI";
  private readonly catalog = new ModelCatalog(fallbackAgyModels());
  private info: AcpInitializeResult | undefined;
  /** Whether the last session listed a `plan` mode; unknown until one has. */
  private planListed: boolean | undefined;
  private found: { command: ResolvedCommand; version: string | null } | undefined;

  constructor(private readonly options: AntigravityAdapterOptions = {}) {}

  /** The CLI to run: a given copy, the one detection found, else one looked up now. */
  private async executable(): Promise<{ command: ResolvedCommand; version: string | null }> {
    if (this.options.executable) return { command: this.options.executable, version: null };
    if (this.found) return this.found;
    const lookup = await findExecutable("agy", {
      ...(this.options.probeTimeoutMs ? { timeoutMs: this.options.probeTimeoutMs } : {}),
      minVersion: AGY_MIN_VERSION,
      ...this.options.locate,
    });
    if (!lookup.command) throw new Error("Antigravity CLI is not installed (no `agy` on PATH)");
    this.found = { command: lookup.command, version: lookup.version };
    return this.found;
  }

  async detect(): Promise<ProviderStatus> {
    this.found = undefined;
    return detectAgy({
      ...(this.options.executable ? { executable: this.options.executable } : {}),
      ...(this.options.locate ? { locate: this.options.locate } : {}),
      ...(this.options.probeTimeoutMs ? { timeoutMs: this.options.probeTimeoutMs } : {}),
      probe: (exe, version) => this.probe(exe, version),
    });
  }

  /** What the CLI reported in `initialize` refines resume, images and MCP. */
  capabilities(): ProviderCapabilities {
    const caps = this.info?.agentCapabilities;
    return {
      ...BASE_CAPABILITIES,
      ...(caps
        ? {
            resume: caps.loadSession === true,
            images: caps.promptCapabilities?.image === true,
            mcp: caps.mcpCapabilities?.http === true,
          }
        : {}),
      ...(this.planListed === false ? { planMode: false } : {}),
    };
  }

  models(): ModelInfo[] {
    return this.catalog.list();
  }

  /** Antigravity CLI lists its models only in a session: Default stands in until one has. */
  onModelsChanged(listener: () => void): () => void {
    return this.catalog.subscribe(listener);
  }

  async openSession(opts: SessionOptions): Promise<ProviderSession> {
    const { command, version } = await this.executable();
    if (version && !isSupportedAgyVersion(version)) {
      throw new ProviderSessionError(
        "version_unsupported",
        `${agyTooOldMessage(version)}. Update it with \`${AGY_UPGRADE_COMMAND}\`.`,
        "setup",
      );
    }
    // Strict settings: every tool action asks, so Agent Rishi's approvals see all of them.
    const cliDir = writeAgySettings(this.options.home);
    const session = new AcpSession(opts, {
      executable: command,
      spec: {
        ...ANTIGRAVITY_AGENT,
        args: [...ANTIGRAVITY_AGENT.args, "--cli_dir_name", cliDir],
        extensions: agyExtensions(path.join(agyDir(this.options.home), "brain")),
      },
      onSetup: (setup, info) => this.onSetup(setup, info),
      ...(this.options.startTimeoutMs ? { startTimeoutMs: this.options.startTimeoutMs } : {}),
      ...(this.options.interruptTimeoutMs
        ? { interruptTimeoutMs: this.options.interruptTimeoutMs }
        : {}),
    });
    try {
      await session.start();
    } catch (error) {
      await session.close();
      throw signInError(error);
    }
    return session;
  }

  /** A session reported its models: they are the account's current ones. */
  private onSetup(setup: AcpSessionSetup, info: AcpInitializeResult): void {
    this.info = info;
    const modes = modeIds(setup);
    if (modes.length) this.planListed = modes.includes(ANTIGRAVITY_AGENT.modes.plan ?? "plan");
    const reported = modelsOf(setup);
    if (reported?.models.length) this.catalog.set(agyModelInfos(setup, reported.models));
  }

  private async probe(exe: ResolvedCommand, version: string | null): Promise<AgyProbe> {
    this.found = { command: exe, version };
    const result = await probeAgy(exe, {
      ...(this.options.probeTimeoutMs ? { timeoutMs: this.options.probeTimeoutMs } : {}),
    });
    if (result.info) this.info = result.info;
    return result;
  }
}

/** A session that couldn't start because Antigravity CLI isn't signed in says how to sign in. */
function signInError(error: unknown): unknown {
  if (classifyAcpError(error) !== "auth") return error;
  const message = error instanceof Error ? error.message : String(error);
  return new ProviderSessionError(
    "not_logged_in",
    `Antigravity CLI is not signed in (${message.replace(/\.$/, "")}). Run \`${AGY_LOGIN_COMMAND}\` and sign in with Google.`,
    "auth",
  );
}
