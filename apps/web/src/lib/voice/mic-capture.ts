// Never inlined as a `data:` URL, which the UI's `script-src 'self'` would block.
import workletUrl from "./pcm-capture.worklet.js?url&no-inline";

/**
 * Live microphone samples for dictation (§11.3): Web Audio hands the raw mono samples to the
 * page as they arrive, so they can be split into segments on pauses while the user speaks
 * (`MediaRecorder` chunks can't be decoded on their own). An AudioWorklet does the copying,
 * with the older ScriptProcessor where worklets aren't available.
 */

/** Receives each batch of mono samples, at the capture's sample rate. */
export type SamplesListener = (samples: Float32Array, sampleRate: number) => void;

export interface MicCapture {
  /** Stop capturing and release the microphone. */
  stop(): void;
}

/** Starts capturing; rejects with a message for the user when it can't. */
export type StartCapture = (onSamples: SamplesListener) => Promise<MicCapture>;

function audioContextCtor(): typeof AudioContext | null {
  if (typeof window === "undefined") return null;
  return (
    window.AudioContext ??
    (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext ??
    null
  );
}

/** True when this browser can capture live microphone samples. */
export function canCapture(): boolean {
  return (
    typeof navigator !== "undefined" &&
    Boolean(navigator.mediaDevices?.getUserMedia) &&
    audioContextCtor() !== null
  );
}

async function connectSink(
  context: AudioContext,
  source: MediaStreamAudioSourceNode,
  onSamples: (samples: Float32Array) => void,
): Promise<AudioNode> {
  if (context.audioWorklet && typeof AudioWorkletNode !== "undefined") {
    try {
      await context.audioWorklet.addModule(workletUrl);
      const node = new AudioWorkletNode(context, "agent-rishi-pcm-capture");
      node.port.onmessage = (e: MessageEvent<Float32Array>) => onSamples(e.data);
      source.connect(node);
      // The node outputs silence; connecting it keeps the graph pulling audio through it.
      node.connect(context.destination);
      return node;
    } catch {
      // Fall back to the ScriptProcessor below.
    }
  }
  const processor = context.createScriptProcessor(2048, 1, 1);
  processor.onaudioprocess = (e) => onSamples(e.inputBuffer.getChannelData(0).slice());
  source.connect(processor);
  processor.connect(context.destination);
  return processor;
}

/** Ask for the microphone and stream its samples to `onSamples` until `stop()`. */
export const startMicCapture: StartCapture = async (onSamples) => {
  const Ctx = audioContextCtor();
  if (!Ctx || !navigator.mediaDevices?.getUserMedia) {
    throw new Error("This browser can't capture the microphone for dictation.");
  }
  // Created before the permission prompt, while the click or key press still counts as a user
  // gesture, so the browser lets the audio start.
  const context = new Ctx();
  let stream: MediaStream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
    });
  } catch {
    void context.close().catch(() => {});
    throw new Error("Microphone access was blocked.");
  }
  const release = () => {
    for (const track of stream.getTracks()) track.stop();
    void context.close().catch(() => {});
  };
  try {
    if (context.state === "suspended") void context.resume().catch(() => {});
    const source = context.createMediaStreamSource(stream);
    const sink = await connectSink(context, source, (samples) =>
      onSamples(samples, context.sampleRate),
    );
    let stopped = false;
    return {
      stop() {
        if (stopped) return;
        stopped = true;
        source.disconnect();
        sink.disconnect();
        release();
      },
    };
  } catch (error) {
    release();
    throw error instanceof Error ? error : new Error(String(error));
  }
};
