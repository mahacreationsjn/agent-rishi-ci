import { tmpdir } from "node:os";
import type { ModelInfo } from "@agent-rishi/contracts";
import type { ResolvedCommand } from "../util/exec";
import { openCodeModelList } from "./models";
import type { OcCredential, OcProvider } from "./protocol";
import { CATALOG_DEADLINE_MS, type CatalogPolling, readProviderCatalog } from "./ready";
import { OpenCodeServer } from "./server";

/** How long a probe may take, server start-up included. */
export const OPENCODE_PROBE_TIMEOUT_MS = 20_000;

/** What a short-lived OpenCode server reports: version, providers, credentials and models. */
export interface OpenCodeProbe {
  version: string | null;
  /** Providers OpenCode can use (credentials, environment variables, config, free tier). */
  providers: OcProvider[];
  /** Integrations with a saved, active credential (`opencode auth login`). */
  connected: string[];
  models: ModelInfo[];
}

export interface OpenCodeProbeOptions {
  timeoutMs?: number;
  /** A project's own config (`readProjectConfig`), for that project's list. */
  projectConfig?: Record<string, unknown>;
  /** How the provider and model lists are polled (`readProviderCatalog`); tests shorten it. */
  catalog?: CatalogPolling;
}

/**
 * Start a private `opencode serve` in the temp directory, read its providers, credentials and
 * models, and stop it. No session is created and no model is called, so nothing is billed.
 * The provider and model lists are polled until they settle: OpenCode 2.4.x loads them after
 * printing its URL, and a single read at start-up sees an empty catalog (#651).
 * Rejects on failure or after `timeoutMs`; the server is stopped either way.
 */
export async function probeOpenCode(
  exe: ResolvedCommand,
  opts: OpenCodeProbeOptions = {},
): Promise<OpenCodeProbe> {
  const timeoutMs = opts.timeoutMs ?? OPENCODE_PROBE_TIMEOUT_MS;
  const budgetEnd = Date.now() + timeoutMs;
  const abort = new AbortController();
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new Error(`OpenCode did not answer within ${timeoutMs}ms`)),
      timeoutMs,
    );
  });
  try {
    return await Promise.race([run(exe, abort.signal, timeoutMs, budgetEnd, opts), timeout]);
  } finally {
    clearTimeout(timer);
    abort.abort();
  }
}

async function run(
  exe: ResolvedCommand,
  signal: AbortSignal,
  timeoutMs: number,
  /** When the probe's budget runs out (`Date.now()` time). */
  budgetEnd: number,
  opts: OpenCodeProbeOptions,
): Promise<OpenCodeProbe> {
  const server = await OpenCodeServer.start(exe, {
    cwd: tmpdir(),
    signal,
    startTimeoutMs: timeoutMs,
    requestTimeoutMs: timeoutMs,
    ...(opts.projectConfig ? { projectConfig: opts.projectConfig } : {}),
  });
  try {
    const c = server.client;
    // What is left of the probe's budget after the start-up, less room for a final read: a
    // slow start still returns the lists read so far instead of timing out the whole probe.
    const left = Math.max(0, budgetEnd - Date.now() - 1_500);
    const [info, credentials, catalog] = await Promise.all([
      c.get<{ version?: string }>("/api/info", signal).catch(() => undefined),
      c.get<{ data: OcCredential[] }>("/api/credential", signal).catch(() => ({ data: [] })),
      readProviderCatalog(c, signal, {
        ...opts.catalog,
        deadlineMs: Math.min(opts.catalog?.deadlineMs ?? CATALOG_DEADLINE_MS, left),
      }),
    ]);
    const connected = [
      ...new Set(
        (credentials.data ?? []).filter((x) => x.active !== false).map((x) => x.integrationID),
      ),
    ];
    return {
      version: typeof info?.version === "string" ? info.version : null,
      providers: catalog.providers,
      connected,
      models: openCodeModelList(catalog.models, catalog.providers, catalog.defaultModel),
    };
  } finally {
    await server.close();
  }
}
