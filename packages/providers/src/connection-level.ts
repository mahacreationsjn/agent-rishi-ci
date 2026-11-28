import type { ConnectionLevel, ProviderStatus } from "@agent-rishi/contracts";

/**
 * The level a detection shows (Foundation §4.3), from what `detect()` found and when a real
 * check last passed for the installed executable:
 *
 * - no level: not installed, or the installed copy can't run (`supported: false`);
 * - `configured`: installed and runs, but no login or key was found (or it could not be read);
 * - `credential_found`: the CLI's own evidence of a login or key (`loggedIn: true`);
 * - `verified`: that, and a real check passed (`verifiedAt`).
 *
 * Pure; reads no provider id.
 */
export function connectionLevel(
  status: Pick<ProviderStatus, "installed" | "supported" | "loggedIn">,
  verifiedAt: number | undefined,
): ConnectionLevel | null {
  if (!status.installed || !status.supported) return null;
  if (status.loggedIn !== true) return "configured";
  return verifiedAt === undefined ? "credential_found" : "verified";
}

/** What tells one login from another, as far as detection can see it. */
function loginOf(status: ProviderStatus): string {
  return [status.executablePath, status.authMethod, status.account].join("\u0000");
}

/**
 * Levels across detections. A real check counts for the login it ran with: when detection sees
 * a different login (another account or method, a sign-out and back in), a check that passed
 * before it doesn't make the new one `verified`; the next check does.
 */
export class ConnectionLevels {
  /** Per provider: the login last seen, and since when (0: the first one seen). */
  private readonly logins = new Map<string, { login: string; since: number; signedIn: boolean }>();

  constructor(private readonly now: () => number = Date.now) {}

  /**
   * `status` with its `level` and `verifiedAt`. `verifiedAt` is when the adapter's last real
   * check passed for the executable it runs now (`ProviderAdapter.verifiedAt`).
   */
  apply(status: ProviderStatus, verifiedAt: number | undefined): ProviderStatus {
    const login = loginOf(status);
    const signedIn = status.loggedIn === true;
    const seen = this.logins.get(status.providerId);
    let since = seen?.since ?? 0;
    if (seen && (seen.login !== login || (signedIn && !seen.signedIn))) since = this.now();
    // An unknown login state (`null`) says nothing about the login: keep what was seen.
    if (!seen || status.loggedIn !== null) {
      this.logins.set(status.providerId, { login, since, signedIn });
    }
    const counted = verifiedAt !== undefined && verifiedAt >= since ? verifiedAt : undefined;
    const level = connectionLevel(status, counted);
    return {
      ...status,
      level,
      verifiedAt: level === "verified" && counted !== undefined ? iso(counted) : null,
    };
  }
}

function iso(ms: number): string {
  return new Date(ms).toISOString();
}
