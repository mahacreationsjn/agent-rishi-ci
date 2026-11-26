import { useState } from "react";

const MODE_KEY = "agent-rishi.factoryView.mode";

/** How the Factory view shows the pipeline: the board, or the 3D factory floor. */
export type ViewModeId = "board" | "floor";

export interface ViewMode {
  /** Floor is offered (at every width: phones show one storey at a time). */
  available: boolean;
  /** What the view shows. */
  mode: ViewModeId;
  set: (mode: ViewModeId) => void;
}

/**
 * The stored mode: `board` or `floor`. The retired pixel mode (`pixel`) opens Floor, which
 * replaced it; anything else, or nothing, is the board.
 */
export function storedViewMode(value: string | null): ViewModeId {
  if (value === "floor" || value === "pixel") return "floor";
  return "board";
}

/**
 * The Factory view's mode (#209, #420, #476): the board by default, remembered per browser.
 * Floor is offered on phones too, one storey at a time with the roster as a bottom sheet.
 */
export function useViewMode(): ViewMode {
  const [mode, setMode] = useState(() => storedViewMode(localStorage.getItem(MODE_KEY)));
  return {
    available: true,
    mode,
    set: (next) => {
      localStorage.setItem(MODE_KEY, next);
      setMode(next);
    },
  };
}
