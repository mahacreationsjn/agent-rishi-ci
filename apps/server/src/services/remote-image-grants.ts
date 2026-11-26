import { randomBytes } from "node:crypto";
import type { RemoteImageGrant } from "@agent-rishi/contracts";

/**
 * Single-use ids for "Load image" (#341). The UI's click asks for one with a JSON `POST`, which
 * no `<img>` can send, and the image then loads from `/api/remote-image/<id>`. An id names one
 * exact URL, works once and expires within a minute, so markup that slipped past the Markdown
 * renderer can't use Agent Rishi's own origin (which the CSP allows) to reach another host.
 * Kept in memory: a restart forgets them, and a reload asks again.
 */

export interface RemoteImageGrantsOptions {
  /** How long an id stays usable; one minute by default (the `<img>` loads right away). */
  ttlMs?: number;
  /** Ids kept at once; the oldest go first. */
  max?: number;
  /** Clock (tests move it). */
  now?: () => number;
}

const TTL_MS = 60_000;
const MAX_GRANTS = 200;

export class RemoteImageGrants {
  private readonly grants = new Map<string, { url: string; expiresAt: number }>();
  private readonly ttlMs: number;
  private readonly max: number;
  private readonly now: () => number;

  constructor(opts: RemoteImageGrantsOptions = {}) {
    this.ttlMs = opts.ttlMs ?? TTL_MS;
    this.max = opts.max ?? MAX_GRANTS;
    this.now = opts.now ?? Date.now;
  }

  /** A new id for exactly `url`. */
  grant(url: string): RemoteImageGrant {
    const now = this.now();
    this.prune(now);
    const id = randomBytes(18).toString("base64url");
    const expiresAt = now + this.ttlMs;
    this.grants.set(id, { url, expiresAt });
    return { id, expiresAt: new Date(expiresAt).toISOString() };
  }

  /** The URL `id` was granted for, once; `undefined` if unknown, expired or already used. */
  take(id: string): string | undefined {
    const grant = this.grants.get(id);
    if (!grant) return undefined;
    this.grants.delete(id);
    return grant.expiresAt > this.now() ? grant.url : undefined;
  }

  /** Drop expired ids, then the oldest while full (a `Map` iterates in insertion order). */
  private prune(now: number): void {
    for (const [id, grant] of this.grants) {
      if (grant.expiresAt <= now) this.grants.delete(id);
    }
    for (const id of this.grants.keys()) {
      if (this.grants.size < this.max) break;
      this.grants.delete(id);
    }
  }
}
