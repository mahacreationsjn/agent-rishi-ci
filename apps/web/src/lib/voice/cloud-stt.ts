import type { SttEngine, SttResponse } from "@agent-rishi/contracts";
import type { AgentRishiClient } from "@/lib/api";
import type { SpeechToText } from "./engines";
import { canCapture, startMicCapture } from "./mic-capture";
import { createSegmentedStt } from "./segmented-stt";
import { toWhisperWav } from "./wav";

/** `en-US` -> `en` (server engines take ISO 639-1 hints). */
export function languageHint(language: string | null | undefined): string | undefined {
  const code = language?.split("-")[0]?.toLowerCase();
  return code && code.length >= 2 ? code : undefined;
}

/**
 * Send a recording to `/api/stt` (the Settings test). Local Whisper takes 16 kHz mono WAV, so
 * the clip is decoded and converted in the browser first; the cloud engines take it as recorded.
 */
export async function transcribeRecording(
  client: AgentRishiClient,
  audio: Blob,
  engine: SttEngine,
  language?: string | null,
): Promise<SttResponse> {
  const body = engine === "local" ? await toWhisperWav(audio) : audio;
  return client.voice.stt(body, { engine, language: languageHint(language) });
}

/**
 * Server-side dictation (§11.3) with ElevenLabs Scribe, OpenAI or local Whisper: the microphone
 * is split into segments on short pauses and each one goes to `/api/stt` as soon as it ends, so
 * text appears while the user speaks.
 */
export function createCloudStt(client: AgentRishiClient, engine: SttEngine): SpeechToText {
  return createSegmentedStt({
    supported: canCapture(),
    capture: startMicCapture,
    transcribe: async (wav, language) =>
      (await client.voice.stt(wav, { engine, language: languageHint(language) })).text,
  });
}
