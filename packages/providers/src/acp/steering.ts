import type { AcpPromptResult } from "./protocol";
import { AcpRpcError } from "./rpc";

/**
 * The prompts of one turn on an agent that takes a `session/prompt` sent while another runs as
 * steering (`AcpAgentSpec.steering`): the earlier prompt then ends at once and the agent goes on
 * with both, the new prompt ending when all of the work is done. So the turn follows its newest
 * prompt and ends when that one does, with every prompt's usage added up.
 *
 * The agent refuses a prompt while one of its requests (a permission, a question) waits for an
 * answer. A steer sent then is held, and goes once nothing waits (`flush`); one the agent
 * refuses anyway (it asked in the meantime) is held again.
 */
export class AcpPromptChain {
  private prompts: Sent[] = [];
  /** Steers (their prompt blocks) waiting for the agent to take them. */
  private held: unknown[] = [];

  constructor(
    private readonly deps: {
      /** Send `session/prompt` with these blocks. */
      send: (prompt: unknown) => Promise<AcpPromptResult>;
      /** Whether the agent can take a prompt now (none of its requests waits for an answer). */
      canSend: () => boolean;
      /** The agent's error for a prompt sent while a request waits (steering agents only). */
      waitRefusal?: RegExp;
    },
  ) {}

  /** Start the turn with its first prompt. */
  begin(prompt: unknown): void {
    this.prompts = [];
    this.held = [];
    this.push(prompt);
  }

  /** A further prompt of the turn: a steer, or a follow-up once its prompt has ended. */
  push(prompt: unknown, steer = false): void {
    const sent: Sent = { done: Promise.resolve(undefined) };
    sent.done = this.deps.send(prompt).then(
      (result) => {
        sent.result = result;
        return result;
      },
      (error: unknown) => {
        // Refused while a request waited: it goes again once that is answered.
        if (steer && this.refusedWhileWaiting(error)) {
          this.prompts = this.prompts.filter((p) => p !== sent);
          this.held.unshift(prompt);
          return undefined;
        }
        throw error;
      },
    );
    this.prompts.push(sent);
  }

  /** Steer the running turn now, or hold the input until nothing waits for an answer. */
  steer(prompt: unknown): void {
    if (this.held.length || !this.deps.canSend()) this.held.push(prompt);
    else this.push(prompt, true);
  }

  /** Send what is held, when the agent can take it; whether anything went. */
  flush(): boolean {
    if (!this.held.length || !this.deps.canSend()) return false;
    const held = this.held;
    this.held = [];
    for (const prompt of held) this.push(prompt, true);
    return true;
  }

  /** Drop what is held (Stop): returns how many messages never reached the agent. */
  dropHeld(): number {
    const count = this.held.length;
    this.held = [];
    return count;
  }

  /** Whether steers are held: the turn sends them before it ends. */
  get holding(): boolean {
    return this.held.length > 0;
  }

  /**
   * Wait until the newest prompt ends with no newer one sent meanwhile. Rejects with the newest
   * prompt's error; an earlier prompt's error is moot once a newer one runs.
   */
  async settle(): Promise<AcpPromptResult | undefined> {
    for (;;) {
      const last = this.prompts.at(-1);
      if (!last) return undefined;
      try {
        const result = await last.done;
        if (last === this.prompts.at(-1)) return result;
      } catch (error) {
        if (last === this.prompts.at(-1)) throw error;
      }
    }
  }

  /** Every prompt's usage, added up. */
  usage(): AcpPromptResult["usage"] {
    let usage: AcpPromptResult["usage"];
    for (const p of this.prompts) usage = addUsage(usage, p.result?.usage);
    return usage;
  }

  private refusedWhileWaiting(error: unknown): boolean {
    const pattern = this.deps.waitRefusal;
    return !!pattern && error instanceof AcpRpcError && pattern.test(error.message);
  }
}

type Sent = { done: Promise<AcpPromptResult | undefined>; result?: AcpPromptResult };

/** Two prompts' token counts added up (each field that either reports). */
export function addUsage(
  a: AcpPromptResult["usage"],
  b: AcpPromptResult["usage"],
): AcpPromptResult["usage"] {
  if (!a) return b;
  if (!b) return a;
  const out: Record<string, unknown> = { ...a };
  for (const [key, value] of Object.entries(b)) {
    const prev = (a as Record<string, unknown>)[key];
    out[key] =
      typeof value === "number" && typeof prev === "number" ? prev + value : (value ?? prev);
  }
  return out as AcpPromptResult["usage"];
}
