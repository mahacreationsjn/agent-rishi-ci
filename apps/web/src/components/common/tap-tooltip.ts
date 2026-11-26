import { type MouseEvent, type PointerEvent, useRef, useState } from "react";

/**
 * A tooltip that a click or a tap opens too, not only mouse hover and keyboard focus (the
 * tooltip primitive ignores touch, so phones and tablets rely on the tap). A second tap closes
 * it; Escape, or a tap anywhere else, closes it. Spread `root` on `Tooltip` and `trigger` on the
 * element inside `TooltipTrigger asChild`.
 */
export function useTapTooltip() {
  const [open, setOpen] = useState(false);
  // The pointer behind the next click, and whether the tooltip was showing when it went down
  // (the primitive closes it on pointer down, before the click arrives).
  const press = useRef<{ type: string; wasOpen: boolean } | null>(null);
  return {
    root: { open, onOpenChange: setOpen },
    trigger: {
      onPointerDown: (e: PointerEvent) => {
        press.current = { type: e.pointerType, wasOpen: open };
      },
      onClick: (e: MouseEvent) => {
        // Keep the primitive from closing it on click; decide here instead.
        e.preventDefault();
        const p = press.current;
        press.current = null;
        if (!p) setOpen((o) => !o);
        else setOpen(p.type === "touch" ? !p.wasOpen : true);
      },
    },
  };
}
