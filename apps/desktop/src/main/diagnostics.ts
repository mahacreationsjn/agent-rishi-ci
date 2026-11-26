import { readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { constants } from "node:os";

const processReasons = [
  "clean-exit",
  "abnormal-exit",
  "killed",
  "crashed",
  "oom",
  "launch-failed",
  "integrity-failure",
  "memory-eviction",
];

const reasons = {
  "server-exit": ["stopped", "expected", "unexpected", "startup"],
  "renderer-exit": processReasons,
  "child-exit": processReasons,
  quit: ["menu", "tray", "window", "server-stop", "server-crash", "startup", "update", "system"],
} satisfies Record<string, readonly string[]>;

type Event = {
  kind: keyof typeof reasons;
  reason: string;
  code?: number | null;
  signal?: string | null;
};

/** Export only fixed process facts. Logs, paths, URLs and renderer data never enter the report. */
export class Diagnostics {
  private readonly events: Event[] = [];

  constructor(private readonly file?: string) {
    if (!file) return;
    try {
      if (statSync(file).size > 32_768) return;
      const saved: unknown = JSON.parse(readFileSync(file, "utf8")).events;
      if (!Array.isArray(saved)) return;
      for (const event of saved.slice(-100)) {
        if (event && typeof event === "object") this.add(event);
      }
    } catch {
      // Missing or unreadable history does not prevent a report for this launch.
    }
  }

  record(event: Event): void {
    this.add(event);
    if (!this.file) return;
    try {
      const temporary = `${this.file}.tmp`;
      writeFileSync(temporary, this.json(), { mode: 0o600 });
      renameSync(temporary, this.file);
    } catch {
      // Keep recording in memory if the diagnostic history cannot be saved.
    }
  }

  private add({ kind, reason, code, signal }: Event): void {
    if (typeof kind !== "string" || !Object.hasOwn(reasons, kind)) return;
    this.events.push({
      kind,
      reason: reasons[kind].includes(reason) ? reason : "unknown",
      ...(code === null || Number.isSafeInteger(code) ? { code } : {}),
      ...(signal === null ||
      (typeof signal === "string" && Object.hasOwn(constants.signals, signal))
        ? { signal }
        : {}),
    });
    if (this.events.length > 100) this.events.shift();
  }

  json(): string {
    return JSON.stringify({ version: 1, events: this.events }, null, 2);
  }
}
