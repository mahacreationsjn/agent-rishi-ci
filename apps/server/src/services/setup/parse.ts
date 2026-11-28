/**
 * Pure parsers for the output of the tools setup checks itself (§14): git and the GitHub CLI.
 * They extract only what the setup screen shows; tokens are never captured.
 */

/** First semver-ish version in a `--version` line (`2.1.3 (Claude Code)`, `codex-cli 0.16.0`). */
export function parseVersion(output: string): string | null {
  return /\d+\.\d+(?:\.\d+)?(?:[-+][\w.]+)?/.exec(output)?.[0] ?? null;
}

export interface GhAuth {
  loggedIn: boolean;
  account: string | null;
}

/** `gh auth status --json hosts` (newer gh). Only the active github.com login is read. */
export function parseGhAuthJson(stdout: string): GhAuth | null {
  try {
    const raw = JSON.parse(stdout) as {
      hosts?: Record<string, Array<{ state?: string; active?: boolean; login?: string }>>;
    };
    if (!raw.hosts) return null;
    const accounts = raw.hosts["github.com"] ?? Object.values(raw.hosts).flat();
    const active = accounts.find((a) => a.active) ?? accounts[0];
    if (!active) return { loggedIn: false, account: null };
    return { loggedIn: active.state === "success", account: active.login ?? null };
  } catch {
    return null;
  }
}

/** Fallback for older gh: the human-readable `gh auth status` text. */
export function parseGhAuthText(code: number | null, output: string): GhAuth {
  const m = /Logged in to [^\s]+ (?:account|as) ([^\s(]+)/i.exec(output);
  return { loggedIn: code === 0 && Boolean(m), account: m?.[1] ?? null };
}
