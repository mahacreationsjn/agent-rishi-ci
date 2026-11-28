import type { ProviderInfo, ProviderStatus } from "@agent-rishi/contracts";
import { type ProviderAdapter, providerInfo, type RefreshModelsOptions } from "./adapter";
import { AntigravityAdapter } from "./antigravity/adapter";
import { ClaudeAdapter } from "./claude/adapter";
import { CodexAdapter } from "./codex/adapter";
import { ConnectionLevels } from "./connection-level";
import { CursorAdapter } from "./cursor/adapter";
import { GeminiAdapter } from "./gemini/adapter";
import { OpenCodeAdapter } from "./opencode/adapter";

/** The set of adapters a runner has loaded, keyed by id. */
export class ProviderRegistry {
  private readonly adapters = new Map<string, ProviderAdapter>();
  private readonly listeners = new Set<() => void>();
  private readonly levels = new ConnectionLevels();

  constructor(adapters: ProviderAdapter[] = []) {
    for (const adapter of adapters) this.register(adapter);
  }

  register(adapter: ProviderAdapter): void {
    if (this.adapters.has(adapter.id)) {
      throw new Error(`Provider "${adapter.id}" is already registered`);
    }
    this.adapters.set(adapter.id, adapter);
    adapter.onModelsChanged?.(() => this.notify());
  }

  get(id: string): ProviderAdapter | undefined {
    return this.adapters.get(id);
  }

  list(): ProviderAdapter[] {
    return [...this.adapters.values()];
  }

  info(): ProviderInfo[] {
    return this.list().map(providerInfo);
  }

  /**
   * Detect the providers (all, or those in `ids`), each status with its level (Foundation
   * §4.3): the one detection, which setup displays. A check that passed earlier (a model list,
   * a session start) already counts; `verify` runs one now, by refreshing the model lists,
   * before answering. Never throws.
   */
  async detect(
    ids?: readonly string[],
    opts: { verify?: boolean } = {},
  ): Promise<ProviderStatus[]> {
    const adapters = this.pick(ids);
    const statuses = await Promise.all(adapters.map((a) => a.detect()));
    if (opts.verify) await this.refreshModels(adapters.map((a) => a.id));
    return this.withLevels(statuses);
  }

  /**
   * These statuses with their levels as of now: after `refreshModels`, a check that has just
   * passed makes a signed-in provider `verified`.
   */
  withLevels(statuses: readonly ProviderStatus[]): ProviderStatus[] {
    return statuses.map((status) =>
      this.levels.apply(status, safeVerifiedAt(this.adapters.get(status.providerId))),
    );
  }

  /**
   * Refresh the model lists of all adapters (or those in `ids`) that support it. Never throws;
   * changes reach `onChange` listeners. `opts.maxAgeMs` skips adapters whose list is recent.
   */
  async refreshModels(ids?: readonly string[], opts?: RefreshModelsOptions): Promise<void> {
    const adapters = this.pick(ids);
    await Promise.all(adapters.map((a) => a.refreshModels?.(opts).catch(() => undefined)));
  }

  /** Call `listener` whenever `info()` changes (a provider's models). Returns unsubscribe. */
  onChange(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private pick(ids?: readonly string[]): ProviderAdapter[] {
    return ids ? this.list().filter((a) => ids.includes(a.id)) : this.list();
  }

  private notify(): void {
    for (const listener of this.listeners) {
      try {
        listener();
      } catch {
        // One failing listener must not stop the others.
      }
    }
  }
}

function safeVerifiedAt(adapter: ProviderAdapter | undefined): number | undefined {
  try {
    return adapter?.verifiedAt?.();
  } catch {
    return undefined;
  }
}

/**
 * Fresh instances of the built-in real providers (Claude Code, Codex, OpenCode, Cursor, Gemini
 * CLI, Antigravity CLI).
 */
export function builtinProviders(): ProviderAdapter[] {
  return [
    new ClaudeAdapter(),
    new CodexAdapter(),
    new OpenCodeAdapter(),
    new CursorAdapter(),
    new GeminiAdapter(),
    new AntigravityAdapter(),
  ];
}

let defaultRegistry: ProviderRegistry | undefined;

/** Process-wide registry of the built-in providers, created on first use. */
export function defaultProviderRegistry(): ProviderRegistry {
  defaultRegistry ??= new ProviderRegistry(builtinProviders());
  return defaultRegistry;
}

/** A built-in provider by id (`claude`, `codex`, `opencode`, `cursor`). */
export function getProvider(id: string): ProviderAdapter | undefined {
  return defaultProviderRegistry().get(id);
}

/** All built-in providers. Check `detect()` for which are installed and logged in. */
export function listProviders(): ProviderAdapter[] {
  return defaultProviderRegistry().list();
}
