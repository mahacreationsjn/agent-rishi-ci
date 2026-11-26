import type { SpeechToText } from "./engines";
import type { StartCapture } from "./mic-capture";
import { createSegmentQueue } from "./segment-queue";
import { createSegmenter, type Segmenter, type SegmenterOptions } from "./segmenter";
import { samplesToWhisperWav } from "./wav";

/**
 * Live dictation for engines that transcribe whole clips (§11.3): the microphone is split into
 * segments on short pauses, and each finished segment is sent as a 16 kHz mono WAV as soon as
 * it ends, so text appears phrase by phrase while the user speaks. Each piece of audio is
 * transcribed once, so a cloud engine costs the same as transcribing the whole recording.
 *
 * Stopping flushes the segment in progress and ends after the last one comes back. A failed
 * segment stops listening and reports the error once; the text already transcribed is kept.
 */
export interface SegmentedSttDeps {
  supported: boolean;
  capture: StartCapture;
  /** Transcribe one segment (a WAV clip) and return its text. */
  transcribe: (wav: Blob, language: string | null | undefined) => Promise<string>;
  /** Tuning for the pause detection (tests). */
  segmenter?: Omit<SegmenterOptions, "sampleRate">;
}

const message = (error: unknown) => (error instanceof Error ? error.message : String(error));

export function createSegmentedStt(deps: SegmentedSttDeps): SpeechToText {
  let session: { stop(): void } | null = null;
  return {
    supported: deps.supported,
    live: "segments",
    finishesAfterStop: true,
    start(opts) {
      session?.stop();
      let listening = true;
      let ended = false;
      let segmenter: Segmenter | null = null;
      let sampleRate = 0;
      let capture: { stop(): void } | null = null;

      const end = () => {
        if (ended) return;
        ended = true;
        opts.onEnd();
      };
      const queue = createSegmentQueue<Blob>({
        transcribe: (wav) => deps.transcribe(wav, opts.language),
        onText: opts.onText,
        onPending: opts.onPending,
        onError: (error) => {
          opts.onError(error);
          finish(false);
        },
      });
      const send = (segment: Float32Array) => queue.add(samplesToWhisperWav(segment, sampleRate));
      /** Stop listening (flushing the segment in progress), then end once every segment is back. */
      const finish = (flush: boolean) => {
        if (!listening) return;
        listening = false;
        capture?.stop();
        capture = null;
        if (flush && segmenter) for (const segment of segmenter.flush()) send(segment);
        void queue.drain().then(() => {
          opts.onText({ final: queue.text, draft: "" });
          end();
        });
      };

      deps
        .capture((samples, rate) => {
          if (!listening) return;
          if (!segmenter) {
            sampleRate = rate;
            segmenter = createSegmenter({ ...deps.segmenter, sampleRate: rate });
          }
          for (const segment of segmenter.push(samples)) send(segment);
          opts.onLevel?.(segmenter.level);
        })
        .then(
          (started) => {
            // Stopped before the microphone was ready: release it straight away.
            if (listening) capture = started;
            else started.stop();
          },
          (error: unknown) => {
            if (!listening) return;
            listening = false;
            opts.onError(message(error));
            end();
          },
        );
      session = { stop: () => finish(true) };
    },
    stop() {
      session?.stop();
      session = null;
    },
  };
}
