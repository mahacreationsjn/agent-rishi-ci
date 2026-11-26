import type { CameraRig } from "./camera";

/**
 * Floor mode's pointer input (#420, #476): drag to pan, the wheel or a two-finger pinch to zoom
 * around the pointer, a double-click to fit the hall again. A press that hardly moves is a tap
 * (it picks what's under it); a mouse moving with no button down hovers. Points are in CSS
 * pixels from the canvas's top left. Returns the function that unbinds it.
 */
export interface InputHandlers {
  /** The camera moved: draw a frame. */
  moved: () => void;
  fit: () => void;
  /** The pointer hovers here (null: it left the canvas). */
  hover: (at: { x: number; y: number } | null) => void;
  tap: (at: { x: number; y: number }) => void;
}

/** A press that moves less than this (CSS pixels) is a tap, not a drag. */
const TAP_SLOP = 5;

export function bindInput(
  canvas: HTMLCanvasElement,
  rig: CameraRig,
  on: InputHandlers,
): () => void {
  const pointers = new Map<number, { x: number; y: number }>();
  let pinch: { distance: number; x: number; y: number } | null = null;
  let press: { id: number; x: number; y: number; far: boolean } | null = null;

  const local = (clientX: number, clientY: number) => {
    const r = canvas.getBoundingClientRect();
    return { x: clientX - r.left, y: clientY - r.top, w: r.width, h: r.height };
  };
  const centreOffset = (clientX: number, clientY: number) => {
    const p = local(clientX, clientY);
    return { ox: p.x - p.w / 2, oy: p.y - p.h / 2 };
  };
  const twoFinger = () => {
    const [a, b] = [...pointers.values()];
    if (!a || !b) return null;
    return { distance: Math.hypot(a.x - b.x, a.y - b.y), x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
  };

  const down = (e: PointerEvent) => {
    if (e.pointerType === "mouse" && e.button !== 0) return;
    canvas.setPointerCapture(e.pointerId);
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    pinch = pointers.size === 2 ? twoFinger() : null;
    press =
      pointers.size === 1 ? { id: e.pointerId, x: e.clientX, y: e.clientY, far: false } : null;
    canvas.style.cursor = "grabbing";
  };
  const move = (e: PointerEvent) => {
    const was = pointers.get(e.pointerId);
    if (!was) {
      if (e.pointerType === "mouse") on.hover(local(e.clientX, e.clientY));
      return;
    }
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (press && Math.hypot(e.clientX - press.x, e.clientY - press.y) > TAP_SLOP) press.far = true;
    if (pointers.size === 1) {
      if (!press?.far) return;
      rig.pan(e.clientX - was.x, e.clientY - was.y);
      on.moved();
      return;
    }
    const now = twoFinger();
    if (!now || !pinch) return;
    const { ox, oy } = centreOffset(now.x, now.y);
    rig.pan(now.x - pinch.x, now.y - pinch.y);
    if (pinch.distance > 0) rig.zoomAt(now.distance / pinch.distance, ox, oy);
    pinch = now;
    on.moved();
  };
  const up = (e: PointerEvent) => {
    const tapped = press && press.id === e.pointerId && !press.far && e.type === "pointerup";
    pointers.delete(e.pointerId);
    pinch = pointers.size === 2 ? twoFinger() : null;
    if (pointers.size === 0) canvas.style.cursor = "grab";
    if (tapped) on.tap(local(e.clientX, e.clientY));
    press = null;
  };
  const leave = (e: PointerEvent) => {
    if (e.pointerType === "mouse" && pointers.size === 0) on.hover(null);
  };
  const wheel = (e: WheelEvent) => {
    e.preventDefault();
    const lines = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? 400 : 1;
    // A trackpad pinch arrives as a wheel with Ctrl held, in smaller steps.
    const factor = Math.exp(-e.deltaY * lines * (e.ctrlKey ? 0.01 : 0.0015));
    const { ox, oy } = centreOffset(e.clientX, e.clientY);
    rig.zoomAt(factor, ox, oy);
    on.moved();
  };
  const double = (e: MouseEvent) => {
    e.preventDefault();
    on.fit();
  };

  canvas.style.cursor = "grab";
  canvas.addEventListener("pointerdown", down);
  canvas.addEventListener("pointermove", move);
  canvas.addEventListener("pointerup", up);
  canvas.addEventListener("pointercancel", up);
  canvas.addEventListener("pointerleave", leave);
  canvas.addEventListener("wheel", wheel, { passive: false });
  canvas.addEventListener("dblclick", double);
  return () => {
    canvas.removeEventListener("pointerdown", down);
    canvas.removeEventListener("pointermove", move);
    canvas.removeEventListener("pointerup", up);
    canvas.removeEventListener("pointercancel", up);
    canvas.removeEventListener("pointerleave", leave);
    canvas.removeEventListener("wheel", wheel);
    canvas.removeEventListener("dblclick", double);
  };
}
