import type { OcModel, OcProvider } from "./protocol";

/** Poll spacing for the catalog reads. */
export const CATALOG_POLL_MS = 400;
/** Consecutive identical non-empty snapshots that settle the catalog (a ~1.6 s steady window). */
export const CATALOG_SETTLE_POLLS = 5;
/** Longest to wait for the catalog before returning the last snapshot seen. */
export const CATALOG_DEADLINE_MS = 12_000;

/** The provider list, model list and configured default of one OpenCode location. */
export interface OcCatalog {
  providers: OcProvider[];
  models: OcModel[];
  defaultModel: OcModel | null;
}

/** The slice of `OpenCodeClient` the catalog read uses (tests pass a stub). */
export interface CatalogReader {
  get<T>(path: string, signal?: AbortSignal): Promise<T>;
}

/** How the catalog is polled; the defaults are the `CATALOG_*` constants. */
export interface CatalogPolling {
  pollMs?: number;
  settlePolls?: number;
  deadlineMs?: number;
}

/**
 * Read `GET /api/provider` + `GET /api/model` + `GET /api/model/default` until they settle.
 *
 * `opencode serve` prints its URL before its location services are ready: OpenCode 2.4.x
 * keeps an empty (sometimes only partially activated) provider and model list for the first
 * seconds, so a single read right after start-up sees nothing (#651). Poll until the same
 * non-empty snapshot arrives `settlePolls` times in a row. An empty list never counts as
 * settled, so an unconfigured OpenCode is only reported empty once `deadlineMs` passes.
 *
 * Snapshots are keyed by ids only (plus variants and the default), since loaded entries do
 * not change. A failure on the first read rejects — the server is not answering at all; a
 * later failure keeps the last good snapshot and retries within the deadline. Known limit:
 * a provider that activates more than `settlePolls` polls after the others settles an earlier
 * snapshot and is missed by that read; the next probe, refresh or session picks it up.
 */
export async function readProviderCatalog(
  client: CatalogReader,
  signal: AbortSignal,
  opts: CatalogPolling = {},
): Promise<OcCatalog> {
  const pollMs = opts.pollMs ?? CATALOG_POLL_MS;
  const settlePolls = Math.max(1, opts.settlePolls ?? CATALOG_SETTLE_POLLS);
  const deadlineMs = opts.deadlineMs ?? CATALOG_DEADLINE_MS;
  const startedAt = Date.now();

  let last: OcCatalog | undefined;
  let lastKey: string | undefined;
  let streak = 0;

  for (;;) {
    let snapshot: OcCatalog;
    try {
      const [providers, models, fallback] = await Promise.all([
        client.get<{ data?: OcProvider[] }>("/api/provider", signal),
        client.get<{ data?: OcModel[] }>("/api/model", signal),
        client
          .get<{ data?: OcModel | null }>("/api/model/default", signal)
          .catch(() => ({ data: null as OcModel | null })),
      ]);
      snapshot = {
        providers: providers.data ?? [],
        models: models.data ?? [],
        defaultModel: fallback.data ?? null,
      };
    } catch (error) {
      if (!last) throw error;
      snapshot = last;
    }
    const key = catalogKey(snapshot);
    const populated = snapshot.providers.length > 0 || snapshot.models.length > 0;
    streak = populated && key === lastKey ? streak + 1 : populated ? 1 : 0;
    last = snapshot;
    lastKey = key;
    if (streak >= settlePolls || Date.now() - startedAt >= deadlineMs) return snapshot;
    await sleep(pollMs, signal);
    if (signal.aborted) return snapshot;
  }
}

/** Identity of a catalog read: provider ids, model ids with their variants and enablement, default. */
function catalogKey(c: OcCatalog): string {
  return [
    c.providers.map((p) => p.id).join(","),
    c.models
      .map(
        (m) =>
          `${m.providerID}/${m.id}${m.enabled === false ? "!" : ""}#${(m.variants ?? [])
            .map((v) => v.id)
            .join("+")}`,
      )
      .join(","),
    c.defaultModel ? `${c.defaultModel.providerID}/${c.defaultModel.id}` : "",
  ].join("|");
}

/** Wait `ms`, or less when `signal` aborts. Leaves no listener behind (a read polls ~30 times). */
function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise<void>((resolve) => {
    if (signal.aborted) {
      resolve();
      return;
    }
    const done = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    signal.addEventListener("abort", done, { once: true });
  });
}
