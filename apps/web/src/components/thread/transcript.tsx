import { useVirtualizer } from "@tanstack/react-virtual";
import { ArrowDown, ArrowUp, Loader2 } from "lucide-react";
import { type ReactNode, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import type { EarlierTurns } from "@/lib/queries";
import type { TranscriptState } from "@/lib/transcript/reducer";
import { buildTimeline, rowIndexOfItem, type TimelineRow } from "@/lib/transcript/timeline";
import { cn } from "@/lib/utils";
import { TimelineRowView } from "./timeline-row";

const gapAfter = (row: TimelineRow, next: TimelineRow | undefined): number => {
  if (!next) return 0;
  const slim = (r: TimelineRow) => r.type === "work" || r.type === "hook";
  if (slim(row) && slim(next)) return 4;
  // An assistant message's Copy action hangs 20px below it; the next row would cover it.
  if (row.type === "user" || next.type === "user" || row.type === "assistant") return 24;
  if (next.type === "turn-end" || row.type === "turn-end") return 18;
  return 14;
};

/** How long a row opened from search stays highlighted. */
const FOCUS_HIGHLIGHT_MS = 2400;

/** Scrolled this close to the top, the page of earlier turns loads. */
const LOAD_EARLIER_PX = 160;

/**
 * Virtualised transcript (§13). Sticks to the bottom while the user is there; scrolling up
 * releases it and shows a "jump to latest" button. With `focusItemId` (a search hit) it opens
 * at that item instead: centred, its work group expanded, briefly highlighted. With `earlier`
 * (a long session opens at its latest turns), scrolling to the top loads the turns before them,
 * keeping what is on screen in place.
 */
export function Transcript({
  transcript,
  threadId,
  sessionId,
  focusItemId,
  footer,
  earlier,
  className,
  contentClassName,
}: {
  transcript: TranscriptState;
  threadId: string;
  sessionId: string;
  focusItemId?: string;
  footer?: ReactNode;
  /** The root turns before the loaded ones, loaded on demand. */
  earlier?: EarlierTurns;
  className?: string;
  contentClassName?: string;
}) {
  const rows = useMemo(() => buildTimeline(transcript, threadId), [transcript, threadId]);
  const scrollRef = useRef<HTMLDivElement>(null);
  const [atBottom, setAtBottom] = useState(true);
  const stick = useRef(true);
  // The row opened from search while it is highlighted, and the item it was opened for.
  const [focus, setFocus] = useState<{ key: string } | null>(null);
  const focusedItem = useRef<string | null>(null);
  const rowsRef = useRef(rows);
  rowsRef.current = rows;
  // Once a transcript has had earlier turns, the slot above the rows stays (its label changes),
  // so the rows don't move when the last page arrives.
  const threadKey = `${sessionId}:${threadId}`;
  const paged = useRef<string | null>(null);
  if (earlier && earlier.count > 0) paged.current = threadKey;

  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: (i) => {
      const type = rows[i]?.type;
      return type === "work" || type === "hook" ? 30 : type === "turn-end" ? 24 : 120;
    },
    getItemKey: (i) => rows[i]?.key ?? i,
    // Earlier turns go in above the rows on screen: keep those rows where they are (by key).
    anchorTo: "end",
    overscan: 8,
  });

  const scrollToEnd = (smooth = false) => {
    const el = scrollRef.current;
    if (!el) return;
    el.scrollTo({ top: el.scrollHeight, behavior: smooth ? "smooth" : "auto" });
  };

  // Jump to the end on first render of a thread, unless it opens at a search hit.
  // biome-ignore lint/correctness/useExhaustiveDependencies: run once per thread.
  useLayoutEffect(() => {
    if (focusItemId && rowIndexOfItem(rows, focusItemId) !== -1) return;
    stick.current = true;
    requestAnimationFrame(() => scrollToEnd());
    const t = setTimeout(() => scrollToEnd(), 120);
    return () => clearTimeout(t);
  }, [threadId]);

  // Open at the search hit once its row exists: stop following the end, then centre it.
  useLayoutEffect(() => {
    if (!focusItemId || focusedItem.current === focusItemId) return;
    const index = rowIndexOfItem(rows, focusItemId);
    const row = rows[index];
    if (!row) return;
    focusedItem.current = focusItemId;
    stick.current = false;
    setAtBottom(false);
    setFocus({ key: row.key });
  }, [focusItemId, rows]);

  useEffect(() => {
    if (!focus) return;
    // By key: earlier turns loaded meanwhile move the row down.
    const centre = () => {
      const index = rowsRef.current.findIndex((r) => r.key === focus.key);
      if (index !== -1) virtualizer.scrollToIndex(index, { align: "center" });
    };
    centre();
    // Rows measure (and the work group opens) after the first scroll: centre again.
    const again = setTimeout(centre, 150);
    const done = setTimeout(() => setFocus(null), FOCUS_HIGHLIGHT_MS);
    return () => {
      clearTimeout(again);
      clearTimeout(done);
    };
  }, [focus, virtualizer]);

  const loadEarlier = () => {
    if (!earlier || earlier.count === 0 || earlier.loading) return;
    stick.current = false;
    earlier.load();
  };

  // Follow new content while pinned.
  const total = virtualizer.getTotalSize();
  // biome-ignore lint/correctness/useExhaustiveDependencies: follow size changes only.
  useEffect(() => {
    if (stick.current && total > 0) scrollToEnd();
  }, [total]);

  return (
    <div className={cn("relative min-h-0 flex-1", className)}>
      <div
        ref={scrollRef}
        data-testid="transcript-scroll"
        className="h-full overflow-y-auto scroll-thin [scrollbar-gutter:stable]"
        onScroll={(e) => {
          const el = e.currentTarget;
          const bottom = el.scrollHeight - el.scrollTop - el.clientHeight < 48;
          stick.current = bottom;
          if (bottom !== atBottom) setAtBottom(bottom);
          // Not while a search hit is being centred: it may sit near the top.
          if (el.scrollTop < LOAD_EARLIER_PX && !focus) loadEarlier();
        }}
      >
        {/* Safety net: long words wrap, and nothing that still overflows can scroll sideways. */}
        <div
          className={cn(
            "mx-auto w-full max-w-[46rem] overflow-x-clip px-6 pt-6 pb-4 wrap-break-word",
            contentClassName,
          )}
        >
          {earlier && paged.current === threadKey && (
            <div className="flex h-11 items-start justify-center">
              {earlier.count > 0 ? (
                <Button
                  size="xs"
                  variant="ghost"
                  className="text-muted-foreground"
                  disabled={earlier.loading}
                  onClick={loadEarlier}
                  data-testid="transcript-earlier"
                >
                  {earlier.loading ? <Loader2 className="animate-spin" /> : <ArrowUp />}
                  {earlier.loading
                    ? "Loading earlier turns…"
                    : `${earlier.count} earlier ${earlier.count === 1 ? "turn" : "turns"}`}
                </Button>
              ) : (
                <span className="pt-1 text-3xs text-muted-foreground">Start of the session</span>
              )}
            </div>
          )}
          <div style={{ height: total, position: "relative" }}>
            {virtualizer.getVirtualItems().map((v) => {
              const row = rows[v.index];
              if (!row) return null;
              const focused = focus?.key === row.key;
              return (
                <div
                  key={v.key}
                  data-index={v.index}
                  ref={virtualizer.measureElement}
                  className="absolute inset-x-0 top-0"
                  style={{
                    transform: `translateY(${v.start}px)`,
                    paddingBottom: gapAfter(row, rows[v.index + 1]),
                  }}
                >
                  <div
                    data-focused={focused || undefined}
                    className={cn(
                      "rounded-xl transition-[background-color,box-shadow] duration-700",
                      focused && "bg-primary/[0.06] ring-1 ring-primary/30",
                    )}
                  >
                    <TimelineRowView
                      row={row}
                      sessionId={sessionId}
                      focusItemId={focused ? focusItemId : undefined}
                    />
                  </div>
                </div>
              );
            })}
          </div>
          {footer}
        </div>
      </div>
      {!atBottom && (
        <Button
          size="xs"
          variant="secondary"
          className="absolute bottom-3 left-1/2 -translate-x-1/2 rounded-full border border-border shadow-md"
          onClick={() => {
            stick.current = true;
            scrollToEnd(true);
          }}
        >
          <ArrowDown /> Latest
        </Button>
      )}
    </div>
  );
}
