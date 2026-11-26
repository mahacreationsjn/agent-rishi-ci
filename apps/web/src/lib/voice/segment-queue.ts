import type { DictationText } from "./engines";

/**
 * Transcribes dictation segments as they finish (§11.3) and keeps their text in order. Each
 * segment is sent once, as soon as it is added, and the results may come back in any order:
 * - `final` is the text of every settled segment before the first one still pending, in order,
 *   so it only ever grows at the end;
 * - `draft` is the text of segments that came back ahead of one still pending.
 *
 * The first failure is reported once. The text of every segment that succeeded is kept,
 * including those after the failed one.
 */
export interface SegmentQueue<T> {
  /** Send a finished segment for transcription. Ignored after a failure. */
  add(segment: T): void;
  /** Resolves once every segment sent so far has come back or failed. */
  drain(): Promise<void>;
  /** The text of every segment that succeeded, in segment order. */
  readonly text: string;
  /** True once a segment failed. */
  readonly failed: boolean;
}

/**
 * Characters of scripts written without spaces between words (Chinese, Japanese, Thai, Lao,
 * Khmer, Burmese), with the CJK and full-width punctuation they use. Script extensions also
 * cover marks those scripts share, such as the Japanese long vowel mark.
 */
const SPACELESS =
  "\\p{scx=Han}\\p{scx=Hiragana}\\p{scx=Katakana}\\p{scx=Thai}\\p{scx=Lao}\\p{scx=Khmer}\\p{scx=Myanmar}\\u3000-\\u303f\\uff01-\\uff60";
const ENDS_SPACELESS = new RegExp(`[${SPACELESS}]$`, "u");
const STARTS_SPACELESS = new RegExp(`^[${SPACELESS}]`, "u");

/**
 * What goes between two pieces of dictated text: nothing where both sides are in a script
 * written without spaces (a pause there is not a word break), a single space otherwise.
 */
export function separator(before: string, after: string): string {
  return ENDS_SPACELESS.test(before) && STARTS_SPACELESS.test(after) ? "" : " ";
}

/** Join transcribed pieces the way their language is written, skipping empty ones. */
export function joinSegments(pieces: readonly string[]): string {
  let text = "";
  for (const piece of pieces) {
    const p = piece.trim();
    if (p) text = text ? text + separator(text, p) + p : p;
  }
  return text;
}

const message = (error: unknown) => (error instanceof Error ? error.message : String(error));

export function createSegmentQueue<T>(opts: {
  transcribe: (segment: T) => Promise<string>;
  onText: (text: DictationText) => void;
  onPending?: (count: number) => void;
  onError: (message: string) => void;
}): SegmentQueue<T> {
  /** One entry per segment, in order: its text, `null` when it failed, `undefined` while pending. */
  const results: (string | null | undefined)[] = [];
  const jobs: Promise<void>[] = [];
  let pending = 0;
  let failed = false;
  let last: DictationText = { final: "", draft: "" };

  const emit = () => {
    let settled = 0;
    while (settled < results.length && results[settled] !== undefined) settled++;
    const texts = (from: number, to: number) =>
      results.slice(from, to).filter((r): r is string => typeof r === "string");
    const next = {
      final: joinSegments(texts(0, settled)),
      draft: joinSegments(texts(settled, results.length)),
    };
    if (next.final === last.final && next.draft === last.draft) return;
    last = next;
    opts.onText(next);
  };

  return {
    get text() {
      return joinSegments(results.filter((r): r is string => typeof r === "string"));
    },
    get failed() {
      return failed;
    },
    add(segment) {
      if (failed) return;
      const index = results.length;
      results.push(undefined);
      pending++;
      opts.onPending?.(pending);
      const job = Promise.resolve()
        .then(() => opts.transcribe(segment))
        .then(
          (text) => {
            results[index] = text;
          },
          (error: unknown) => {
            results[index] = null;
            if (failed) return;
            failed = true;
            opts.onError(message(error));
          },
        )
        .finally(() => {
          pending--;
          opts.onPending?.(pending);
          emit();
        });
      jobs.push(job);
    },
    async drain() {
      // Segments can be added while earlier ones are in flight; wait until none are left.
      let seen = -1;
      while (seen !== jobs.length) {
        seen = jobs.length;
        await Promise.all(jobs);
      }
    },
  };
}
