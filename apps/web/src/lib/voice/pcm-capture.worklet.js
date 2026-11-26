/**
 * AudioWorklet for live dictation (§11.3): copies the microphone's samples, mixed down to mono,
 * to the page in batches of about 20 ms, where they are split into segments on pauses. A plain
 * script, loaded as a same-origin file, so the UI's `script-src 'self'` allows it.
 */
const BATCH = 1024;

class PcmCapture extends AudioWorkletProcessor {
  constructor() {
    super();
    this.batch = new Float32Array(BATCH);
    this.length = 0;
  }

  process(inputs) {
    const channels = inputs[0];
    const first = channels?.[0];
    if (!first) return true;
    for (let i = 0; i < first.length; i++) {
      let sum = 0;
      for (const channel of channels) sum += channel[i] ?? 0;
      this.batch[this.length++] = sum / channels.length;
      if (this.length === BATCH) {
        this.port.postMessage(this.batch, [this.batch.buffer]);
        this.batch = new Float32Array(BATCH);
        this.length = 0;
      }
    }
    return true;
  }
}

registerProcessor("agent-rishi-pcm-capture", PcmCapture);
