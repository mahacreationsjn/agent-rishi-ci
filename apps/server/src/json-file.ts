import { readFileSync } from "node:fs";
import { writeFileDurably } from "@agent-rishi/providers";

/** Read and parse a JSON file; `undefined` when missing or unparsable. */
export function readJsonFile(file: string): unknown {
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return undefined;
  }
}

/**
 * Write JSON atomically and durably (`writeFileDurably`): readers never see a partial file, and
 * a power cut leaves the old file or the new one, never an empty one.
 */
export function writeJsonFile(file: string, value: unknown, mode?: number): void {
  writeFileDurably(file, `${JSON.stringify(value, null, 2)}\n`, mode ? { mode } : {});
}
