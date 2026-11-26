import { Loader2 } from "lucide-react";
import { useSyncExternalStore } from "react";
import type { Dictation, LevelStore } from "./use-dictation";

/** An RMS level as 0..1 for the meter: about -55 dBFS (a quiet room) to -10 dBFS (loud speech). */
export function meterLevel(rms: number): number {
  const db = 20 * Math.log10(Math.max(rms, 1e-6));
  return Math.min(1, Math.max(0, (db + 55) / 45));
}

/** Relative heights of the meter's bars, highest in the middle. */
const BARS = [0.55, 0.85, 1, 0.8, 0.6];

/** A live level meter, or a pulsing dot when the engine doesn't report a level. */
function LevelMeter({ store }: { store: LevelStore }) {
  const level = useSyncExternalStore(store.subscribe, store.get);
  if (level === null) {
    return (
      <span aria-hidden className="relative mt-[7px] flex size-2 shrink-0">
        <span className="absolute inset-0 animate-ping rounded-full bg-status-failed/50" />
        <span className="relative size-2 rounded-full bg-status-failed" />
      </span>
    );
  }
  const m = meterLevel(level);
  return (
    <span
      aria-hidden
      data-testid="dictation-level"
      className="mt-[3px] flex h-4 shrink-0 items-center gap-[2px]"
    >
      {BARS.map((weight) => (
        <span
          key={weight}
          className="w-[3px] rounded-full bg-status-failed/80 transition-[height] duration-75"
          style={{ height: `${20 + 80 * m * weight}%` }}
        />
      ))}
    </span>
  );
}

/**
 * What dictation is doing, inside the composer under the text (§11.3): a live level meter and
 * "Listening…" before any text arrives, text still in progress in muted italics (it becomes
 * normal text in the draft once settled), and "Transcribing…" while segments are on their way.
 */
export function DictationStrip({ dictation }: { dictation: Dictation }) {
  const { phase, draft, pending, heard, engine, level } = dictation;
  if (phase === "idle") return null;
  const status = draft
    ? null
    : phase === "finishing" || pending > 0
      ? "Transcribing…"
      : "Listening…";
  return (
    <div
      data-testid="dictation-strip"
      className="flex items-start gap-2 px-4 pb-1.5 text-[13px] leading-relaxed text-muted-foreground"
    >
      {phase === "listening" ? (
        <LevelMeter store={level} />
      ) : (
        <Loader2 aria-hidden className="mt-[3px] size-3.5 shrink-0 animate-spin" />
      )}
      {draft && (
        <span data-testid="dictation-draft" className="min-w-0 italic text-muted-foreground/75">
          {draft}
        </span>
      )}
      {status && (
        <span role="status">
          {status}
          {status === "Listening…" && !heard && engine.live === "segments" && (
            <span className="text-muted-foreground/60"> Text appears after each pause.</span>
          )}
        </span>
      )}
    </div>
  );
}
