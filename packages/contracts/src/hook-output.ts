import type { HookRunOutcome, ItemStatus } from "./items";

/**
 * Most characters of a hook run's output kept on its `hook_run` item (§12.4). Hooks print a
 * reason or a little context; anything longer is cut in the middle.
 */
export const HOOK_OUTPUT_MAX_CHARS = 4_000;

/** The item `status` of a `hook_run` with each outcome. */
export const HOOK_RUN_STATUS: Readonly<Record<HookRunOutcome, ItemStatus>> = {
  running: "in_progress",
  succeeded: "completed",
  failed: "failed",
  blocked: "declined",
  cancelled: "cancelled",
};

/** A hook run's output as kept on its item. */
export interface TrimmedHookOutput {
  output: string;
  /** True when part of the output was cut. */
  outputTruncated: boolean;
}

const isHighSurrogate = (code: number) => code >= 0xd800 && code <= 0xdbff;
const isLowSurrogate = (code: number) => code >= 0xdc00 && code <= 0xdfff;

/**
 * Trim a hook's output (surrounding blank space) and cut it to `max` characters, keeping its
 * start (what the hook said first) and its end (where an error usually is) around a
 * `… N characters cut …` line. Never splits a surrogate pair. Pure.
 */
export function trimHookOutput(text: string, max = HOOK_OUTPUT_MAX_CHARS): TrimmedHookOutput {
  const trimmed = text.trim();
  if (trimmed.length <= max) return { output: trimmed, outputTruncated: false };
  // The marker's own length depends on the count, which depends on the marker: size it for the
  // longest count it can show (the whole text cut), so the result never exceeds `max`.
  const room = Math.max(0, max - marker(trimmed.length).length);
  let headEnd = Math.ceil(room / 2);
  let tailStart = trimmed.length - (room - headEnd);
  if (isHighSurrogate(trimmed.charCodeAt(headEnd - 1))) headEnd--;
  if (isLowSurrogate(trimmed.charCodeAt(tailStart))) tailStart++;
  const head = trimmed.slice(0, headEnd);
  const tail = trimmed.slice(tailStart);
  return { output: `${head}${marker(tailStart - headEnd)}${tail}`, outputTruncated: true };
}

function marker(cut: number): string {
  return `\n… ${cut.toLocaleString("en-US")} characters cut …\n`;
}
