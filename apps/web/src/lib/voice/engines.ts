/**
 * Voice engines (§11.3) sit behind small interfaces so cloud or local engines can be swapped in.
 * The browser implementations are the defaults.
 */

/** One dictation update: the running transcript, split into settled text and text in progress. */
export interface DictationText {
  /** Settled text, in order. It goes into the composer's draft. */
  final: string;
  /**
   * Text still in progress, shown muted after the draft: interim words that may still change,
   * or segments that came back ahead of one still being transcribed.
   */
  draft: string;
}

export interface SpeechToText {
  readonly supported: boolean;
  /**
   * How text arrives while the user speaks: `interim` word by word (revised as it goes), or
   * `segments` phrase by phrase, after each short pause.
   */
  readonly live: "interim" | "segments";
  /** True when the last text can arrive after `stop()` (segments still being transcribed). */
  readonly finishesAfterStop: boolean;
  /**
   * Start listening. `onText` receives the running transcript of this dictation. `onEnd` runs
   * once, after the last text; `onError` may come before it.
   */
  start(opts: {
    language?: string | null;
    onText: (text: DictationText) => void;
    /** The microphone's input level (RMS, 0..1), from engines that can measure it. */
    onLevel?: (level: number) => void;
    /** How many segments are being transcribed. */
    onPending?: (count: number) => void;
    onEnd: () => void;
    onError: (message: string) => void;
  }): void;
  stop(): void;
}

export interface TextToSpeech {
  readonly supported: boolean;
  /** `onEnd` runs once when the utterance finishes, fails or is cancelled. */
  speak(text: string, opts?: { voice?: string | null; rate?: number; onEnd?: () => void }): void;
  cancel(): void;
  voices(): { id: string; label: string; lang: string }[];
}

interface RecognitionResultList {
  length: number;
  [index: number]: { isFinal: boolean; 0: { transcript: string } };
}
interface Recognition {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  onresult: ((e: { resultIndex: number; results: RecognitionResultList }) => void) | null;
  onerror: ((e: { error: string }) => void) | null;
  onend: (() => void) | null;
  start(): void;
  stop(): void;
}
type RecognitionCtor = new () => Recognition;

function recognitionCtor(): RecognitionCtor | null {
  if (typeof window === "undefined") return null;
  const w = window as unknown as {
    SpeechRecognition?: RecognitionCtor;
    webkitSpeechRecognition?: RecognitionCtor;
  };
  return w.SpeechRecognition ?? w.webkitSpeechRecognition ?? null;
}

const UNAVAILABLE_KEY = "agent-rishi.voice.browserSttUnavailable";
/**
 * Recognition errors that mean the speech service itself is missing here (some browsers and
 * embedded runtimes ship the API without a service behind it), not a one-off problem.
 */
const SERVICE_ERRORS = new Set(["network", "service-not-allowed"]);

/**
 * Whether browser speech recognition works here, by capability: `unsupported` when the API
 * is missing, `failed` once its service has failed (remembered per browser), else
 * `available`.
 */
export function browserSttAvailability(): "available" | "unsupported" | "failed" {
  if (!recognitionCtor()) return "unsupported";
  try {
    if (window.localStorage.getItem(UNAVAILABLE_KEY) === "1") return "failed";
  } catch {
    // storage blocked: assume it works
  }
  return "available";
}

/** Forget a remembered failure (the user picked the browser engine again). */
export function resetBrowserSttAvailability(): void {
  try {
    window.localStorage.removeItem(UNAVAILABLE_KEY);
  } catch {
    // storage blocked
  }
}

function markBrowserSttFailed(): void {
  try {
    window.localStorage.setItem(UNAVAILABLE_KEY, "1");
  } catch {
    // storage blocked
  }
}

export const BROWSER_STT_UNAVAILABLE =
  "Browser speech recognition isn't available here. Choose Local (Whisper) in Settings > Voice.";

export function createBrowserStt(): SpeechToText {
  const Ctor = recognitionCtor();
  let rec: Recognition | null = null;
  return {
    get supported() {
      return browserSttAvailability() === "available";
    },
    live: "interim",
    finishesAfterStop: false,
    start({ language, onText, onEnd, onError }) {
      if (!Ctor) {
        onError(BROWSER_STT_UNAVAILABLE);
        return;
      }
      rec = new Ctor();
      rec.lang = language ?? navigator.language;
      rec.continuous = true;
      rec.interimResults = true;
      let finalText = "";
      let interim = "";
      rec.onresult = (e) => {
        interim = "";
        for (let i = e.resultIndex; i < e.results.length; i++) {
          const r = e.results[i];
          if (!r) continue;
          if (r.isFinal) finalText += r[0].transcript;
          else interim += r[0].transcript;
        }
        onText({ final: finalText.trim(), draft: interim.trim() });
      };
      rec.onerror = (e) => {
        if (SERVICE_ERRORS.has(e.error)) {
          markBrowserSttFailed();
          onError(BROWSER_STT_UNAVAILABLE);
          return;
        }
        onError(e.error === "not-allowed" ? "Microphone access was blocked." : e.error);
      };
      rec.onend = () => {
        rec = null;
        // Interim words the service never finalised are kept, not lost.
        if (interim.trim()) onText({ final: (finalText + interim).trim(), draft: "" });
        interim = "";
        onEnd();
      };
      rec.start();
    },
    stop() {
      rec?.stop();
    },
  };
}

export function createBrowserTts(): TextToSpeech {
  const synth = typeof window !== "undefined" ? window.speechSynthesis : undefined;
  return {
    supported: Boolean(synth),
    speak(text, opts) {
      if (!synth || !text) {
        opts?.onEnd?.();
        return;
      }
      synth.cancel();
      const u = new SpeechSynthesisUtterance(text);
      let ended = false;
      // Cancelling fires `error` ("interrupted") in some browsers and `end` in others.
      u.onend = u.onerror = () => {
        if (ended) return;
        ended = true;
        opts?.onEnd?.();
      };
      const voice = synth.getVoices().find((v) => v.voiceURI === opts?.voice);
      if (voice) u.voice = voice;
      u.rate = opts?.rate ?? 1.05;
      synth.speak(u);
    },
    cancel() {
      synth?.cancel();
    },
    voices() {
      return (synth?.getVoices() ?? []).map((v) => ({
        id: v.voiceURI,
        label: v.name,
        lang: v.lang,
      }));
    },
  };
}

export const stt: SpeechToText = createBrowserStt();
export const tts: TextToSpeech = createBrowserTts();
