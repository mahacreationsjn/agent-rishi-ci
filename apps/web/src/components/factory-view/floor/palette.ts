import { useEffect, useState } from "react";
import { cssToSrgb, oklchToSrgb, type Rgb } from "@/lib/oklch";
import type { AgentRole } from "../scene/agents";

/**
 * Floor mode's colours (#420), from the app's theme: the accents are the theme's own tokens, read
 * from its CSS variables, and the hall's surfaces follow the light or dark theme. Read at mount
 * and again whenever the theme changes, so both themes look right.
 */

export interface FloorPalette {
  dark: boolean;
  floor: Rgb;
  wall: Rgb;
  /** Painted lane lines: the theme's primary colour. */
  lane: Rgb;
  /** Painted zone names on the floor. */
  paint: string;
  sky: Rgb;
  /** Steel: desk legs, frames, posts. */
  steel: Rgb;
  /** Desk and workbench tops. */
  desk: Rgb;
  bench: Rgb;
  laptop: Rgb;
  wood: Rgb;
  paper: Rgb;
  belt: Rgb;
  glass: Rgb;
  sign: Rgb;
  signInk: string;
  hazard: Rgb;
  /** Desk props: the bug in the jar and the reviewer's pen. */
  red: Rgb;
  /** Desk props: polished metal (a wrench, a jar's lid, a clip), bright against any desk top. */
  chrome: Rgb;
  /** Desk props: a blueprint roll. */
  blueprint: Rgb;
  /** Desk props: sticky notes, in turn. */
  notes: Rgb[];
  /** The signal tower's lamps, lit. `caution` (pink) is also what waits on a person. */
  lamp: { green: Rgb; caution: Rgb; red: Rgb };
  /** The tip light at rest: warm white. */
  tip: Rgb;
  /** Eyes and mouth. */
  ink: Rgb;
  /** Accessory and badge rim colour per role. */
  accent: Record<AgentRole, Rgb>;
  /** Repair bay crates by kind. */
  crate: { retry: Rgb; stuck: Rgb; merge: Rgb };
  /** Light strengths for this theme. */
  light: { hemi: number; sun: number };
}

const ok = (l: number, c: number, h: number): Rgb => oklchToSrgb(l, c, h);

/** A theme variable's colour, else the fallback (the token's value in the issue's table). */
function token(style: CSSStyleDeclaration | null, name: string, fallback: Rgb): Rgb {
  const value = style?.getPropertyValue(name).trim();
  return (value && cssToSrgb(value)) || fallback;
}

/** The palette for the document's current theme. */
export function readPalette(
  root: HTMLElement | null = globalThis.document?.documentElement,
): FloorPalette {
  const dark = root?.classList.contains("dark") ?? false;
  const style = root ? getComputedStyle(root) : null;
  const primary = token(style, "--primary", ok(0.6, 0.13, 235));
  const chart2 = token(style, "--chart-2", ok(0.5, 0.13, 245));
  const chart3 = token(style, "--chart-3", ok(0.62, 0.14, 155));
  const chart4 = token(style, "--chart-4", ok(0.6, 0.17, 300));
  return {
    dark,
    floor: dark ? ok(0.3, 0.008, 264) : ok(0.93, 0.006, 80),
    wall: dark ? ok(0.36, 0.008, 264) : ok(0.97, 0.005, 80),
    lane: primary,
    paint: dark ? "rgba(214, 220, 232, 0.34)" : "rgba(70, 64, 56, 0.3)",
    sky: ok(0.98, 0.012, 85),
    steel: dark ? ok(0.52, 0.012, 255) : ok(0.68, 0.012, 255),
    desk: dark ? ok(0.6, 0.06, 65) : ok(0.76, 0.06, 70),
    bench: dark ? ok(0.5, 0.03, 240) : ok(0.62, 0.03, 240),
    laptop: ok(0.33, 0.01, 260),
    wood: dark ? ok(0.58, 0.08, 65) : ok(0.7, 0.08, 70),
    paper: ok(0.97, 0.01, 90),
    belt: ok(0.27, 0.006, 260),
    glass: ok(0.86, 0.04, 215),
    sign: ok(0.27, 0.012, 264),
    signInk: "#f5f3ee",
    hazard: ok(0.84, 0.16, 90),
    red: ok(0.6, 0.21, 27),
    chrome: ok(0.88, 0.008, 250),
    blueprint: ok(0.52, 0.13, 255),
    notes: [ok(0.9, 0.15, 98), ok(0.8, 0.12, 350), ok(0.84, 0.1, 200)],
    lamp: { green: ok(0.72, 0.17, 155), caution: ok(0.76, 0.16, 350), red: ok(0.65, 0.2, 25) },
    tip: ok(0.85, 0.02, 80),
    ink: cssToSrgb("#1D2129") as Rgb,
    accent: {
      builder: primary,
      reviewer: chart2,
      rebaser: chart4,
      integrator: chart4,
      pm: chart3,
      scout: ok(0.66, 0.11, 195),
      area: ok(0.74, 0.09, 195),
    },
    crate: { retry: ok(0.76, 0.16, 350), stuck: ok(0.65, 0.2, 25), merge: primary },
    light: dark ? { hemi: 1.5, sun: 1.6 } : { hemi: 1.9, sun: 1.9 },
  };
}

/** The palette, read again whenever the theme changes (the root's `dark` class or style). */
export function useFloorPalette(): FloorPalette {
  const [palette, setPalette] = useState(readPalette);
  useEffect(() => {
    const root = document.documentElement;
    const observer = new MutationObserver(() => setPalette(readPalette(root)));
    observer.observe(root, { attributes: true, attributeFilter: ["class", "style"] });
    return () => observer.disconnect();
  }, []);
  return palette;
}
