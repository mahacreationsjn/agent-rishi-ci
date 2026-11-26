import { useCallback, useEffect, useRef, useState } from "react";

/**
 * The hovered or focused thing in a factory scene (Floor mode's figures, crates and roster):
 * a short delay before closing lets the pointer reach its card, and Escape closes it.
 */
export function useHover() {
  const [key, setKey] = useState<string | null>(null);
  const timer = useRef(0);
  const enter = useCallback((k: string) => {
    window.clearTimeout(timer.current);
    setKey(k);
  }, []);
  const leave = useCallback(() => {
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => setKey(null), 200);
  }, []);
  const close = useCallback(() => {
    window.clearTimeout(timer.current);
    setKey(null);
  }, []);
  useEffect(() => () => window.clearTimeout(timer.current), []);
  // Escape closes an open card.
  useEffect(() => {
    if (key === null) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && close();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [key, close]);
  return { key, enter, leave, close };
}
