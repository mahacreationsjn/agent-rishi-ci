import type { ItemRecord, SessionSnapshot, Turn } from "@agent-rishi/contracts";
import { beforeEach, describe, expect, it } from "vitest";
import { latestTurns } from "@/components/factory-view/latest-turns";
import { MockWorld } from "@/lib/api/mock/world";
import { applyTranscriptMessage } from "@/lib/transcript/apply-transcript";
import { mergeTranscripts } from "@/lib/transcript/merge";
import { transcriptFromSnapshot } from "@/lib/transcript/reducer";
import { buildTimeline, latestFollowups } from "@/lib/transcript/timeline";
import { useTranscriptsStore } from "@/stores/transcripts";

// A long session opens at its latest root turns and loads earlier pages as you scroll up
// (#321): each page is merged into the transcript already loaded.

const T = "t1";
const base = new MockWorld().sessionSnapshot("s-checkout");
const at = (n: number) => `2026-11-07T10:${String(n).padStart(2, "0")}:00.000Z`;

/** Root turn `u<n>`, started at minute n: a message and a reply at positions 2n and 2n+1. */
function turn(n: number): Turn {
  return {
    id: `u${n}`,
    sessionId: "s1",
    threadId: T,
    status: "completed",
    startedAt: at(n),
    completedAt: at(n),
    error: null,
  };
}

function items(n: number): ItemRecord[] {
  const record = (position: number, item: ItemRecord["item"]): ItemRecord => ({
    sessionId: "s1",
    threadId: T,
    turnId: `u${n}`,
    position,
    item,
    createdAt: at(n),
    updatedAt: at(n),
  });
  return [
    record(2 * n, {
      id: `in-${n}`,
      kind: "user_message",
      status: "completed",
      input: { text: `Message ${n}`, attachments: [] },
    }),
    record(2 * n + 1, {
      id: `out-${n}`,
      kind: "assistant_message",
      status: "completed",
      text: `Reply ${n}`,
    }),
  ];
}

/** Root turns `from` to `to` (inclusive) of a session with `earlier` turns before them. */
function page(seq: number, from: number, to: number): SessionSnapshot {
  const ns = Array.from({ length: to - from + 1 }, (_, i) => from + i);
  return {
    seq,
    session: { ...base.session, id: "s1", rootThreadId: T },
    threads: [
      {
        id: T,
        sessionId: "s1",
        parentThreadId: null,
        parentItemId: null,
        title: null,
        agentType: null,
        createdAt: at(0),
      },
    ],
    turns: ns.map(turn),
    items: ns.flatMap(items),
    earlierTurns: from,
  };
}

const rootTurns = (s: ReturnType<typeof transcriptFromSnapshot>) => s.threads[T]?.turnIds;
const rootItems = (s: ReturnType<typeof transcriptFromSnapshot>) => s.threads[T]?.itemIds;

describe("merging pages of a transcript", () => {
  it("prepends an earlier page in order, keeping the latest turn's place", () => {
    const latest = transcriptFromSnapshot(page(10, 6, 9));
    expect(latest.earlierTurns).toBe(6);
    const merged = mergeTranscripts(latest, transcriptFromSnapshot(page(12, 2, 5)));
    expect(rootTurns(merged)).toEqual(["u2", "u3", "u4", "u5", "u6", "u7", "u8", "u9"]);
    expect(rootItems(merged)?.slice(0, 3)).toEqual(["in-2", "out-2", "in-3"]);
    expect(rootItems(merged)?.at(-1)).toBe("out-9");
    expect(merged.earlierTurns).toBe(2);
    expect(merged.seq).toBe(12);
    // Only the thread's latest turn is the latest one (Fork from here, follow-ups).
    const latestEnds = buildTimeline(merged, T).flatMap((r) =>
      r.type === "turn-end" && r.latest ? [r.turn.id] : [],
    );
    expect(latestEnds).toEqual(["u9"]);
    expect(latestFollowups(merged, T)).toBeNull();
  });

  it("keeps what is newer where both hold the same item", () => {
    const live = applyTranscriptMessage(transcriptFromSnapshot(page(10, 6, 9)), {
      type: "transcript",
      sessionId: "s1",
      seq: 15,
      threads: [],
      turns: [],
      items: [
        {
          ...(items(9)[1] as ItemRecord),
          item: { id: "out-9", kind: "assistant_message", status: "completed", text: "Edited" },
        },
      ],
    });
    // An earlier page read before that change: its copy of turn 9 must not win.
    const merged = mergeTranscripts(live, transcriptFromSnapshot(page(12, 3, 9)));
    const reply = merged.items["out-9"]?.item;
    expect(reply?.kind === "assistant_message" && reply.text).toBe("Edited");
    expect(merged.seq).toBe(15);
    expect(merged.earlierTurns).toBe(3);
    expect(rootTurns(merged)).toEqual(["u3", "u4", "u5", "u6", "u7", "u8", "u9"]);
  });
});

describe("transcripts store", () => {
  beforeEach(() => useTranscriptsStore.setState({ byId: {} }));
  const loaded = () => {
    const t = useTranscriptsStore.getState().byId.s1;
    if (!t) throw new Error("s1 isn't loaded");
    return t;
  };

  it("adds an earlier page to the loaded turns and ignores a page it already holds", () => {
    const { load } = useTranscriptsStore.getState();
    load(page(10, 6, 9));
    load(page(11, 2, 5));
    expect(rootTurns(loaded())).toHaveLength(8);
    expect(loaded().earlierTurns).toBe(2);
    const before = loaded();
    // The quick chat's smaller page of the same moment changes nothing.
    load(page(11, 8, 9));
    expect(loaded()).toBe(before);
    // After a resync the snapshot replaces what was there.
    load(page(20, 8, 9), { replace: true });
    expect(loaded().earlierTurns).toBe(8);
  });

  it("ignores live changes to root turns before the loaded ones", () => {
    const { load, applyTranscript } = useTranscriptsStore.getState();
    load(page(10, 6, 9));
    applyTranscript({
      type: "transcript",
      sessionId: "s1",
      seq: 11,
      threads: [],
      // A late change to an old turn, and a new turn.
      turns: [{ ...turn(1), status: "failed" }, turn(10)],
      items: [...items(1), ...items(10)],
    });
    expect(rootTurns(loaded())).toEqual(["u6", "u7", "u8", "u9", "u10"]);
    expect(loaded().items["in-1"]).toBeUndefined();
    expect(rootItems(loaded())?.at(-1)).toBe("out-10");
  });
});

describe("quick chat", () => {
  it("counts turns never loaded among the hidden ones", () => {
    const latest = transcriptFromSnapshot(page(10, 6, 8));
    expect(latestTurns(latest, T, 3).hidden).toBe(6);
    expect(latestTurns(transcriptFromSnapshot(page(10, 4, 8)), T, 3).hidden).toBe(6);
  });
});
