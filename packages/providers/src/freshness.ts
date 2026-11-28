import { statSync } from "node:fs";
import type { ResolvedCommand } from "./util/exec";

/**
 * Identifies the installed executable a model list came from: its path and the size and
 * modification time of the file that actually runs (a symlink is followed). An update that
 * rewrites the file in place or points the launcher at a new version changes it.
 * `undefined` when nothing is installed.
 */
export function executableFingerprint(cmd: ResolvedCommand | undefined): string | undefined {
  if (!cmd) return undefined;
  const target = cmd.kind === "node-script" ? cmd.script : cmd.path;
  try {
    const stat = statSync(target);
    return `${cmd.kind}|${cmd.path}|${target}|${stat.size}|${stat.mtimeMs}`;
  } catch {
    return `${cmd.kind}|${cmd.path}|${target}|missing`;
  }
}

/**
 * When an adapter's model list was last confirmed by the provider (discovery or a session),
 * and for which executable. Lets cheap triggers such as a server reconnect skip a CLI start
 * when the list is recent and the executable has not changed.
 */
export class ModelFreshness {
  private at: number | undefined;
  private confirmedFor: string | undefined;

  constructor(private readonly now: () => number = Date.now) {}

  /** The provider just reported its list, running the executable with this fingerprint. */
  confirm(fingerprint: string | undefined): void {
    this.at = this.now();
    this.confirmedFor = fingerprint;
  }

  /**
   * When the provider last answered with its list, running the executable with this
   * fingerprint (undefined: never since start, or a different executable since). That answer
   * is a real check of the CLI and its login (Foundation §4.3): what `verified` rests on.
   */
  confirmedAt(fingerprint: string | undefined): number | undefined {
    if (this.at === undefined) return undefined;
    return this.confirmedFor === fingerprint ? this.at : undefined;
  }

  /** True when the list was confirmed within `maxAgeMs`, by the same executable. */
  isFresh(fingerprint: string | undefined, maxAgeMs: number): boolean {
    if (this.at === undefined || this.confirmedFor !== fingerprint) return false;
    return this.now() - this.at < maxAgeMs;
  }
}
