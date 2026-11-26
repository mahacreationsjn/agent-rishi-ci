import { getEventListeners } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { OcCatalog } from "../src/opencode/ready";
import { readProviderCatalog } from "../src/opencode/ready";

/**
 * The catalog read against a scripted OpenCode: each step is one snapshot
 * (`pollMs` apart). The last step repeats forever. `fail` fails that step's
 * provider-list read; the model and default reads keep answering.
 */
interface Step {
  providers?: { id: string }[];
  models?: { id: string; providerID: string; variants?: { id: string }[] }[];
  default?: { id: string; providerID: string } | null;
  fail?: boolean;
}

class FakeCatalog {
  polls = 0;
  private step = 0;

  constructor(private readonly steps: Step[]) {}

  get<T>(path: string): Promise<T> {
    // All three reads of one poll see the same step; the default read is the last one
    // made per poll (reads are issued in order), so it advances the step.
    if (path === "/api/provider") this.polls += 1;
    const s = this.steps[Math.min(this.step, this.steps.length - 1)] ?? {};
    if (path === "/api/provider") {
      if (s.fail) return Promise.reject(new Error("provider list failed"));
      return Promise.resolve({ data: s.providers ?? [] }) as Promise<T>;
    }
    if (path === "/api/model") return Promise.resolve({ data: s.models ?? [] }) as Promise<T>;
    this.step += 1;
    return Promise.resolve({ data: s.default ?? null }) as Promise<T>;
  }
}

const model = (providerID: string, id: string, variants: string[] = []) => ({
  id,
  providerID,
  ...(variants.length ? { variants: variants.map((v) => ({ id: v })) } : {}),
});

const full = (extra: "openai" | "both" = "both"): Step => ({
  providers:
    extra === "openai"
      ? [{ id: "openai" }]
      : [{ id: "openai" }, { id: "opencode" }, { id: "splash" }],
  models:
    extra === "openai"
      ? [model("openai", "gpt-6.2-sol", ["low", "high"])]
      : [
          model("openai", "gpt-6.2-sol", ["low", "high"]),
          model("opencode", "big-pickle"),
          model("splash", "qwen38-flashNext", ["low", "medium", "xhigh"]),
        ],
  default:
    extra === "openai" ? model("openai", "gpt-6.2-sol") : model("splash", "qwen38-flashNext"),
});

async function read(catalog: FakeCatalog, opts = {}) {
  const signal = new AbortController().signal;
  const run = readProviderCatalog(catalog, signal, opts);
  // Attach a handler before flushing timers so a rejection is captured, not "unhandled".
  const settled = run.then(
    (value) => ({ value, error: undefined as unknown }),
    (error: unknown) => ({ value: undefined as OcCatalog | undefined, error }),
  );
  await vi.runAllTimersAsync();
  return settled;
}

afterEach(() => {
  vi.useRealTimers();
});

describe("OpenCode catalog readiness", () => {
  it("waits through a staged activation instead of returning the first non-empty list", async () => {
    vi.useFakeTimers();
    // The real 2.4.x shape: an empty list for a while, one provider briefly, then the full
    // set. The partial phase is shorter than the settle window, so it never settles.
    const partial = full("openai");
    const c = new FakeCatalog([
      { providers: [], models: [], default: null },
      { providers: [], models: [], default: null },
      partial,
      partial,
      full(),
      full(),
      full(),
    ]);
    const { value, error } = await read(c, { pollMs: 250, settlePolls: 3, deadlineMs: 30_000 });
    expect(error).toBeUndefined();
    expect(value?.providers.map((p) => p.id)).toEqual(["openai", "opencode", "splash"]);
    expect(value?.defaultModel?.id).toBe("qwen38-flashNext");
    // Empty (2), partial (2, streak never reaches 3), full (3) settles at the 7th read.
    expect(c.polls).toBe(7);
  });

  it("settles an already-complete list after settlePolls reads, not after a deadline", async () => {
    vi.useFakeTimers();
    const c = new FakeCatalog([full()]);
    const { value, error } = await read(c, { pollMs: 250, settlePolls: 3, deadlineMs: 30_000 });
    expect(error).toBeUndefined();
    expect(value?.models).toHaveLength(3);
    expect(c.polls).toBe(3);
  });

  it("never settles empty: an unconfigured OpenCode reports empty only at the deadline", async () => {
    vi.useFakeTimers();
    const c = new FakeCatalog([{ providers: [], models: [], default: null }]);
    const { value, error } = await read(c, { pollMs: 100, settlePolls: 3, deadlineMs: 1_000 });
    expect(error).toBeUndefined();
    expect(value?.providers).toEqual([]);
    expect(value?.models).toEqual([]);
    expect(c.polls).toBe(11); // t=0..1000 inclusive
  });

  it("reads once with no time left: the probe's budget was spent starting the server", async () => {
    vi.useFakeTimers();
    const c = new FakeCatalog([{ providers: [], models: [], default: null }, full()]);
    const { value, error } = await read(c, { pollMs: 100, settlePolls: 3, deadlineMs: 0 });
    expect(error).toBeUndefined();
    expect(value?.models).toEqual([]);
    expect(c.polls).toBe(1);
  });

  it("leaves no abort listener on the caller's signal after polling", async () => {
    vi.useFakeTimers();
    const c = new FakeCatalog([{ providers: [], models: [], default: null }]);
    const signal = new AbortController().signal;
    const run = readProviderCatalog(c, signal, { pollMs: 100, settlePolls: 3, deadlineMs: 1_000 });
    await vi.runAllTimersAsync();
    await run;
    expect(c.polls).toBe(11);
    expect(getEventListeners(signal, "abort")).toHaveLength(0);
  });

  it("rejects when the server cannot answer the first read at all", async () => {
    vi.useFakeTimers();
    const c = new FakeCatalog([{ fail: true }]);
    const { value, error } = await read(c, { pollMs: 100, settlePolls: 2, deadlineMs: 5_000 });
    expect(value).toBeUndefined();
    expect((error as Error).message).toContain("provider list failed");
    expect(c.polls).toBe(1);
  });

  it("keeps the last good snapshot through a transient failure and settles after", async () => {
    vi.useFakeTimers();
    const c = new FakeCatalog([
      full(),
      { fail: true }, // transient: the last snapshot carries through
      full(),
      full(),
    ]);
    const { value, error } = await read(c, { pollMs: 100, settlePolls: 3, deadlineMs: 5_000 });
    expect(error).toBeUndefined();
    expect(value?.models).toHaveLength(3);
  });

  it("treats a variants-only change as new information and re-settles", async () => {
    vi.useFakeTimers();
    const bare = {
      ...full(),
      providers: [{ id: "splash" }],
      models: [model("splash", "qwen38-flashNext")],
    };
    const c = new FakeCatalog([bare, bare, full(), full(), full()]);
    const { value, error } = await read(c, { pollMs: 100, settlePolls: 3, deadlineMs: 5_000 });
    expect(error).toBeUndefined();
    expect(value?.models.find((m) => m.id === "qwen38-flashNext")?.variants).toHaveLength(3);
    // The variant arrival reset the streak: 5 reads, not 3.
    expect(c.polls).toBe(5);
  });
});
