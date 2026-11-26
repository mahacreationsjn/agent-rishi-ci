import { eq } from "drizzle-orm";
import type { Db } from "../../db/client";
import { providerBackoffs } from "../../db/schema";

/**
 * The factory's back-off after a session failed because of its provider (§10.1, Provider
 * availability), kept in `provider_backoffs` so a restart doesn't try the provider again at
 * once. `ProviderAvailability` reads it on start and writes every change through.
 */

/** Why a provider is skipped for new factory work, and until when. */
export interface ProviderBackoff {
  reason: string;
  /** Until when; for a sign-in failure, the safety re-try (the back-off ends on a new login). */
  until: string;
  /** A sign-in failure: skipped until the login changes, or the safety re-try. */
  signin: boolean;
  /** For a sign-in failure: the login detection reported when it failed (null: not yet seen). */
  login: string | null;
  failedAt: string;
}

export class ProviderBackoffStore {
  constructor(private readonly db: Db) {}

  all(): Map<string, ProviderBackoff> {
    const rows = this.db.select().from(providerBackoffs).all();
    return new Map(rows.map(({ provider, ...b }) => [provider, b]));
  }

  put(provider: string, backoff: ProviderBackoff): void {
    this.db
      .insert(providerBackoffs)
      .values({ provider, ...backoff })
      .onConflictDoUpdate({ target: providerBackoffs.provider, set: backoff })
      .run();
  }

  remove(provider: string): void {
    this.db.delete(providerBackoffs).where(eq(providerBackoffs.provider, provider)).run();
  }
}
