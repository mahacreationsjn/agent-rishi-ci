import { describe, expect, it } from "vitest";
import { providerHue, providerMark, providerTone } from "@/components/common/provider-logos";
import { cssToSrgb, oklchToSrgb, parseOklch, srgbToHex } from "@/lib/oklch";

/** Issue #420: Floor mode turns the theme's OKLCH colours into numbers WebGL can use. */

describe("OKLCH to sRGB", () => {
  const close = (a: number[], b: number[]) => {
    for (const [i, v] of a.entries()) expect(v).toBeCloseTo(b[i] as number, 2);
  };

  it("maps known colours", () => {
    close(oklchToSrgb(1, 0, 0), [1, 1, 1]);
    close(oklchToSrgb(0, 0, 0), [0, 0, 0]);
    // sRGB red, green and blue.
    close(oklchToSrgb(0.62796, 0.25768, 29.2339), [1, 0, 0]);
    close(oklchToSrgb(0.86644, 0.29483, 142.4953), [0, 1, 0]);
    close(oklchToSrgb(0.45201, 0.31321, 264.052), [0, 0, 1]);
    // #808080 is oklch(0.6 0 0).
    expect(srgbToHex(oklchToSrgb(0.6, 0, 0))).toBe("#808080");
  });

  it("clips colours outside the sRGB gamut into 0..1", () => {
    for (const v of oklchToSrgb(0.7, 0.4, 145)) {
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThanOrEqual(1);
    }
  });

  it("reads the theme's oklch() strings, with percentages, degrees and alpha", () => {
    expect(parseOklch("oklch(0.66 0.165 58)")).toEqual({ l: 0.66, c: 0.165, h: 58, alpha: 1 });
    expect(parseOklch(" oklch(66% 50% 58deg / 25%) ")).toEqual({
      l: 0.66,
      c: 0.2,
      h: 58,
      alpha: 0.25,
    });
    expect(parseOklch("oklch(0.3 0.01 264 / 0.5)")?.alpha).toBe(0.5);
    expect(parseOklch("rgb(1 2 3)")).toBeNull();
    expect(parseOklch("oklch(a b c)")).toBeNull();
  });

  it("reads hex and oklch CSS colours, and nothing else", () => {
    expect(cssToSrgb("#ff0000")).toEqual([1, 0, 0]);
    expect(cssToSrgb("#0f0")).toEqual([0, 1, 0]);
    expect(srgbToHex(cssToSrgb("oklch(1 0 0)") ?? [0, 0, 0])).toBe("#ffffff");
    expect(cssToSrgb("var(--primary)")).toBeNull();
  });
});

describe("provider tones and marks", () => {
  it("gives the bundled providers their own tone", () => {
    expect(providerTone("claude")).toEqual({ l: 0.7, c: 0.11, h: 45 });
    expect(providerTone("gemini")).toEqual({ l: 0.7, c: 0.1, h: 265 });
    expect(providerTone("codex")).toEqual({ l: 0.93, c: 0.005, h: 260 });
    expect(providerTone("cursor")).toEqual({ l: 0.42, c: 0.01, h: 260 });
    expect(providerTone("opencode")).toEqual({ l: 0.62, c: 0.02, h: 250 });
  });

  it("falls back to a soft tone at the monogram hue for any other provider", () => {
    expect(providerHue("fake")).toBe(300);
    expect(providerTone("fake")).toEqual({ l: 0.72, c: 0.09, h: 300 });
    const hue = ("z".charCodeAt(0) * 37) % 360;
    expect(providerTone("zed")).toEqual({ l: 0.72, c: 0.09, h: hue });
    expect(providerHue("")).toBe(0);
    // Inherited object keys aren't providers.
    expect(providerTone("constructor").l).toBe(0.72);
  });

  it("exports the bundled marks' paths, and none for providers without one", () => {
    expect(providerMark("claude")?.[0]?.fill).toBe("#D97757");
    expect(providerMark("gemini")).toHaveLength(2);
    expect(providerMark("fake")).toBeUndefined();
    expect(providerMark("toString")).toBeUndefined();
  });
});
