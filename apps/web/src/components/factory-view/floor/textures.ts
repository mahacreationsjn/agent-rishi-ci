import { providerMark } from "@/components/common/provider-logos";
import { oklchToSrgb, type Rgb, srgbToHex } from "@/lib/oklch";
import { BOOTH, WALKWAY, type WorkshopLayout } from "../scene/layout";
import { canvasOf } from "./kit";
import type { FloorPalette } from "./palette";

/**
 * Floor mode's textures (#420), drawn on canvases at runtime so nothing is fetched: the painted
 * floor (lane lines, zone names, the repair bay's hazard stripes), the sign text, provider badges,
 * the count displays and the budget dial.
 */

const FONT = `"Geist Variable", system-ui, sans-serif`;
const hex = srgbToHex;

/** Pixels per world unit on the floor, smaller for very long halls so the canvas stays modest. */
export function floorScale(layout: WorkshopLayout): number {
  const { x0, x1 } = layout.bounds;
  return Math.max(24, Math.min(64, Math.floor(4096 / (x1 - x0))));
}

/** A cheap repeatable noise, so the concrete looks the same on every paint. */
function speckle(i: number): number {
  const x = Math.sin(i * 12.9898) * 43758.5453;
  return x - Math.floor(x);
}

/** The whole floor in one texture: concrete, lane lines, zone names and the bay's stripes. */
export function floorCanvas(layout: WorkshopLayout, p: FloorPalette): HTMLCanvasElement {
  const { x0, x1, z0, z1 } = layout.bounds;
  const s = floorScale(layout);
  const canvas = canvasOf((x1 - x0) * s, (z1 - z0) * s);
  const ctx = canvas.getContext("2d");
  if (!ctx) return canvas;
  const px = (x: number) => (x - x0) * s;
  const pz = (z: number) => (z - z0) * s;
  ctx.fillStyle = hex(p.floor);
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  // Concrete: faint speckles and a few seams every four units.
  for (let i = 0; i < canvas.width * canvas.height * 0.0016; i++) {
    ctx.fillStyle = speckle(i * 3) > 0.5 ? "rgba(255,255,255,0.05)" : "rgba(0,0,0,0.05)";
    ctx.fillRect(speckle(i) * canvas.width, speckle(i * 7 + 1) * canvas.height, 2, 2);
  }
  ctx.strokeStyle = p.dark ? "rgba(0,0,0,0.18)" : "rgba(0,0,0,0.05)";
  ctx.lineWidth = 1;
  for (let x = Math.ceil(x0 / 4) * 4; x < x1; x += 4) {
    ctx.beginPath();
    ctx.moveTo(px(x), 0);
    ctx.lineTo(px(x), canvas.height);
    ctx.stroke();
  }

  // Lane lines in the primary colour: both edges of each walkway between zones, and along the
  // front walkway.
  ctx.fillStyle = hex(p.lane);
  const line = Math.max(2, s * 0.05);
  const front = z1 - WALKWAY;
  const zones = layout.zones;
  zones.forEach((zone, i) => {
    const next = zones[i + 1];
    const right = next ? next.x0 : layout.booth.x0 - 0.1;
    ctx.fillRect(px(zone.x1 + 0.08) - line / 2, pz(z0 + 0.15), line, pz(front) - pz(z0 + 0.15));
    ctx.fillRect(px(right - 0.08) - line / 2, pz(z0 + 0.15), line, pz(front) - pz(z0 + 0.15));
  });
  ctx.fillRect(
    px(layout.bay.x1 + 0.1),
    pz(front) - line / 2,
    px(x1 - 0.15) - px(layout.bay.x1 + 0.1),
    line,
  );

  // Zone names, in capitals, in the front walkway (Intake's between its pallet and the bay).
  ctx.fillStyle = p.paint;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  for (const zone of zones) {
    const width = (zone.x1 - zone.x0 - 0.1) * s;
    const z = zone.id === "intake" ? (layout.bay.z0 + layout.pallet.z1) / 2 : z1 - WALKWAY / 2;
    let size = s * 0.42;
    ctx.font = `800 ${size}px ${FONT}`;
    const measured = ctx.measureText(zone.label).width;
    if (measured > width) size *= width / measured;
    ctx.font = `800 ${size}px ${FONT}`;
    ctx.fillText(zone.label, px((zone.x0 + zone.x1) / 2), pz(z));
  }

  // The repair bay: hazard stripes inside a painted border.
  const bay = layout.bay;
  ctx.save();
  ctx.beginPath();
  ctx.rect(px(bay.x0), pz(bay.z0), (bay.x1 - bay.x0) * s, (bay.z1 - bay.z0) * s);
  ctx.clip();
  ctx.fillStyle = p.dark ? "rgba(0,0,0,0.25)" : "rgba(0,0,0,0.06)";
  ctx.fill();
  ctx.fillStyle = hex(p.hazard);
  const band = s * 0.16;
  const edge = s * 0.18;
  for (let i = -canvas.height; i < canvas.width; i += band * 2) {
    ctx.beginPath();
    ctx.moveTo(i, pz(bay.z1));
    ctx.lineTo(i + band, pz(bay.z1));
    ctx.lineTo(i + band + canvas.height, pz(bay.z1) - canvas.height);
    ctx.lineTo(i + canvas.height, pz(bay.z1) - canvas.height);
    ctx.closePath();
    ctx.fill();
  }
  ctx.restore();
  ctx.fillStyle = hex(p.floor);
  ctx.fillRect(
    px(bay.x0) + edge,
    pz(bay.z0) + edge,
    (bay.x1 - bay.x0) * s - edge * 2,
    (bay.z1 - bay.z0) * s - edge * 2,
  );

  // Where the shipping crew stands: painted squares.
  ctx.strokeStyle = p.paint;
  ctx.lineWidth = Math.max(1.5, s * 0.03);
  for (const seat of layout.seats.ship) {
    const half = 0.32 * s;
    ctx.strokeRect(px(seat.stand.x) - half, pz(seat.stand.z) - half, half * 2, half * 2);
  }
  // A marked bay under the PM's booth.
  ctx.strokeRect(px(layout.booth.x0) - 3, pz(layout.booth.z0), BOOTH.w * s + 6, BOOTH.d * s + 3);
  return canvas;
}

/** Text on a dark sign, one row per label, for an atlas: row i spans v from 1 - (i+1)/n to 1 - i/n. */
export function signAtlas(
  labels: readonly string[],
  p: FloorPalette,
  aspect = 4,
): HTMLCanvasElement {
  const rowH = 64;
  const w = rowH * aspect;
  const canvas = canvasOf(w, rowH * labels.length);
  const ctx = canvas.getContext("2d");
  if (!ctx) return canvas;
  labels.forEach((label, i) => {
    const y = i * rowH;
    ctx.fillStyle = hex(p.sign);
    ctx.fillRect(0, y, w, rowH);
    ctx.fillStyle = hex(p.lane);
    ctx.fillRect(0, y + rowH - 6, w, 6);
    ctx.fillStyle = p.signInk;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    let size = rowH * 0.52;
    ctx.font = `700 ${size}px ${FONT}`;
    const measured = ctx.measureText(label).width;
    if (measured > w * 0.88) size *= (w * 0.88) / measured;
    ctx.font = `700 ${size}px ${FONT}`;
    ctx.fillText(label, w / 2, y + rowH * 0.46);
  });
  return canvas;
}

/** A display: a big number with a caption under it. */
export function displayCanvas(value: string, caption: string, p: FloorPalette): HTMLCanvasElement {
  const canvas = canvasOf(256, 128);
  const ctx = canvas.getContext("2d");
  if (!ctx) return canvas;
  ctx.fillStyle = hex(p.sign);
  ctx.fillRect(0, 0, 256, 128);
  ctx.strokeStyle = hex(p.lane);
  ctx.lineWidth = 6;
  ctx.strokeRect(3, 3, 250, 122);
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillStyle = hex(p.lamp.caution);
  ctx.font = `700 64px ${FONT}`;
  ctx.fillText(value, 128, 54);
  ctx.fillStyle = p.signInk;
  ctx.font = `600 20px ${FONT}`;
  ctx.fillText(caption, 128, 104);
  return canvas;
}

/**
 * The status board over the dock: today's merges, agents working and items waiting on you, as
 * three big figures with their captions. The waiting figure is pink when someone waits.
 */
export function boardCanvas(
  merged: number,
  working: number,
  waiting: number,
  p: FloorPalette,
): HTMLCanvasElement {
  const canvas = canvasOf(576, 176);
  const ctx = canvas.getContext("2d");
  if (!ctx) return canvas;
  ctx.fillStyle = hex(p.sign);
  ctx.fillRect(0, 0, 576, 176);
  ctx.strokeStyle = hex(p.lane);
  ctx.lineWidth = 6;
  ctx.strokeRect(3, 3, 570, 170);
  const cols: [string, string, string][] = [
    [String(merged), "MERGED TODAY", hex(p.lamp.green)],
    [String(working), "AGENTS WORKING", p.signInk],
    [String(waiting), "WAITING ON YOU", waiting > 0 ? hex(p.lamp.caution) : p.signInk],
  ];
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  cols.forEach(([value, caption, ink], i) => {
    const x = 96 + i * 192;
    if (i > 0) {
      ctx.fillStyle = "rgba(255,255,255,0.12)";
      ctx.fillRect(i * 192, 24, 2, 128);
    }
    ctx.fillStyle = ink;
    ctx.font = `700 72px ${FONT}`;
    ctx.fillText(value, x, 74);
    ctx.fillStyle = p.signInk;
    ctx.font = `600 19px ${FONT}`;
    ctx.fillText(caption, x, 138);
  });
  return canvas;
}

/** The sign on intake's door while the factory drains: CLOSED, in white on red. */
export function closedCanvas(p: FloorPalette): HTMLCanvasElement {
  const canvas = canvasOf(240, 80);
  const ctx = canvas.getContext("2d");
  if (!ctx) return canvas;
  ctx.fillStyle = hex(p.lamp.red);
  ctx.fillRect(0, 0, 240, 80);
  ctx.strokeStyle = "#ffffff";
  ctx.lineWidth = 5;
  ctx.strokeRect(6, 6, 228, 68);
  ctx.fillStyle = "#ffffff";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.font = `800 46px ${FONT}`;
  ctx.fillText("CLOSED", 120, 43);
  return canvas;
}

/** The budget dial: a round gauge from green through pink to red, its needle at `fraction`. */
export function dialCanvas(fraction: number, p: FloorPalette): HTMLCanvasElement {
  const canvas = canvasOf(256, 256);
  const ctx = canvas.getContext("2d");
  if (!ctx) return canvas;
  const c = 128;
  ctx.fillStyle = hex(p.sign);
  ctx.beginPath();
  ctx.arc(c, c, 124, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = "#f6f4f0";
  ctx.beginPath();
  ctx.arc(c, c, 108, 0, Math.PI * 2);
  ctx.fill();
  const start = Math.PI * 0.75;
  const sweep = Math.PI * 1.5;
  const bands: [number, number, Rgb][] = [
    [0, 0.6, p.lamp.green],
    [0.6, 0.85, p.lamp.caution],
    [0.85, 1, p.lamp.red],
  ];
  ctx.lineWidth = 18;
  for (const [a, b, rgb] of bands) {
    ctx.strokeStyle = hex(rgb);
    ctx.beginPath();
    ctx.arc(c, c, 86, start + sweep * a, start + sweep * b);
    ctx.stroke();
  }
  const angle = start + sweep * Math.min(1, Math.max(0, fraction));
  ctx.strokeStyle = "#1d2129";
  ctx.lineWidth = 8;
  ctx.lineCap = "round";
  ctx.beginPath();
  ctx.moveTo(c, c);
  ctx.lineTo(c + Math.cos(angle) * 76, c + Math.sin(angle) * 76);
  ctx.stroke();
  ctx.fillStyle = "#1d2129";
  ctx.beginPath();
  ctx.arc(c, c, 12, 0, Math.PI * 2);
  ctx.fill();
  ctx.font = `700 30px ${FONT}`;
  ctx.textAlign = "center";
  ctx.fillText(`${Math.round(fraction * 100)}%`, c, c + 64);
  ctx.font = `600 18px ${FONT}`;
  ctx.fillText("BUDGET", c, c + 90);
  return canvas;
}

/** A provider's badge: its mark (or the monogram of its name) on a light disc. */
export function badgeCanvas(
  providerId: string | null,
  name: string | null,
  hue: number,
): HTMLCanvasElement {
  const canvas = canvasOf(128, 128);
  const ctx = canvas.getContext("2d");
  if (!ctx) return canvas;
  ctx.fillStyle = "#F6F4F0";
  ctx.fillRect(0, 0, 128, 128);
  const mark = providerId ? providerMark(providerId) : undefined;
  if (mark && typeof Path2D !== "undefined") {
    ctx.save();
    ctx.translate(24, 24);
    ctx.scale(80 / 24, 80 / 24);
    for (const path of mark) {
      ctx.fillStyle = path.fill ?? "#1D2129";
      ctx.fill(new Path2D(path.d), path.evenOdd ? "evenodd" : "nonzero");
    }
    ctx.restore();
    return canvas;
  }
  ctx.fillStyle = hex(oklchToSrgb(0.6, 0.14, hue));
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.font = `800 76px ${FONT}`;
  ctx.fillText((name || providerId || "?").charAt(0).toUpperCase(), 64, 70);
  return canvas;
}

/** A soft round shadow: black, fading out to the edge. */
export function shadowCanvas(): HTMLCanvasElement {
  const canvas = canvasOf(64, 64);
  const ctx = canvas.getContext("2d");
  if (!ctx) return canvas;
  const g = ctx.createRadialGradient(32, 32, 4, 32, 32, 32);
  g.addColorStop(0, "rgba(0,0,0,1)");
  g.addColorStop(0.55, "rgba(0,0,0,0.7)");
  g.addColorStop(1, "rgba(0,0,0,0)");
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, 64, 64);
  return canvas;
}

/** A roll-up door's slats. */
export function slatsCanvas(p: FloorPalette): HTMLCanvasElement {
  const canvas = canvasOf(128, 128);
  const ctx = canvas.getContext("2d");
  if (!ctx) return canvas;
  ctx.fillStyle = hex(p.steel);
  ctx.fillRect(0, 0, 128, 128);
  ctx.fillStyle = "rgba(0,0,0,0.22)";
  for (let y = 6; y < 128; y += 12) ctx.fillRect(0, y, 128, 2);
  ctx.fillStyle = "rgba(255,255,255,0.12)";
  for (let y = 8; y < 128; y += 12) ctx.fillRect(0, y, 128, 1);
  return canvas;
}

/** The scout's map: the codebase as a few regions on a grid, with pins where it looked. */
export function mapCanvas(p: FloorPalette): HTMLCanvasElement {
  const canvas = canvasOf(256, 128);
  const ctx = canvas.getContext("2d");
  if (!ctx) return canvas;
  ctx.fillStyle = "#e9e3d3";
  ctx.fillRect(0, 0, 256, 128);
  ctx.strokeStyle = "rgba(60, 70, 90, 0.18)";
  ctx.lineWidth = 1;
  for (let x = 16; x < 256; x += 16) {
    ctx.beginPath();
    ctx.moveTo(x, 0);
    ctx.lineTo(x, 128);
    ctx.stroke();
  }
  for (let y = 16; y < 128; y += 16) {
    ctx.beginPath();
    ctx.moveTo(0, y);
    ctx.lineTo(256, y);
    ctx.stroke();
  }
  const regions: [number, number, number, number, Rgb][] = [
    [18, 14, 80, 46, p.accent.reviewer],
    [110, 20, 70, 60, p.accent.pm],
    [190, 12, 52, 50, p.accent.scout],
    [30, 72, 96, 42, p.lane],
    [150, 86, 86, 30, p.accent.rebaser],
  ];
  for (const [x, y, w, h, rgb] of regions) {
    ctx.fillStyle = `${hex(rgb)}55`;
    ctx.strokeStyle = hex(rgb);
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.roundRect(x, y, w, h, 8);
    ctx.fill();
    ctx.stroke();
  }
  ctx.fillStyle = hex(p.lamp.red);
  for (const [x, y] of [
    [60, 34],
    [146, 52],
    [212, 30],
    [88, 92],
  ] as const) {
    ctx.beginPath();
    ctx.arc(x, y, 5, 0, Math.PI * 2);
    ctx.fill();
  }
  return canvas;
}

/** A small whiteboard with a few marker strokes. */
export function whiteboardCanvas(p: FloorPalette): HTMLCanvasElement {
  const canvas = canvasOf(128, 80);
  const ctx = canvas.getContext("2d");
  if (!ctx) return canvas;
  ctx.fillStyle = "#fbfbf8";
  ctx.fillRect(0, 0, 128, 80);
  ctx.lineWidth = 5;
  ctx.lineCap = "round";
  ctx.strokeStyle = hex(p.accent.reviewer);
  ctx.beginPath();
  ctx.moveTo(16, 22);
  ctx.lineTo(70, 22);
  ctx.moveTo(16, 40);
  ctx.lineTo(54, 40);
  ctx.stroke();
  ctx.strokeStyle = hex(p.lane);
  ctx.beginPath();
  ctx.arc(96, 42, 16, 0, Math.PI * 2);
  ctx.moveTo(16, 58);
  ctx.lineTo(80, 58);
  ctx.stroke();
  return canvas;
}
