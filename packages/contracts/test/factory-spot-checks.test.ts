import { describe, expect, it } from "vitest";
import {
  FactoryDigest,
  FactorySpotCheckRequest,
  FactorySpotChecks,
  FactoryStatus,
  FactoryTuning,
  FactoryTuningPatch,
  InboxItemKind,
  SetAutonomyModeRequest,
  SPOT_CHECK_DARK_FACTORY_DEFAULT,
  SPOT_CHECK_NOTE_MAX,
  SpotCheck,
  type SpotCheckEntry,
  spotCheckProblemPercent,
  spotCheckShare,
} from "../src";
import { ts } from "./fixtures";

const check: SpotCheck = {
  reason: "sampled",
  state: "problem",
  sampledAt: ts,
  checkedAt: ts,
  note: "The new route skips the token check",
  issue: { number: 12, url: "https://github.com/acme/app/issues/12", title: "Spot-check: x" },
};

const entry: SpotCheckEntry = {
  itemId: "i1",
  title: "Add a counter",
  pr: { number: 4, url: "https://github.com/acme/app/pull/4", state: "merged" },
  issue: { number: 3, url: "https://github.com/acme/app/issues/3" },
  check,
  mergedAt: ts,
  verdict: { verdict: "approve", summary: "Looks right" },
};

describe("spot-checks (#380)", () => {
  it("defaults the share to the mode: 10% in a dark factory, off otherwise", () => {
    const tuning = FactoryTuning.parse({});
    expect(tuning.spotCheckPercent).toBeNull();
    expect(spotCheckShare("dark_factory", tuning)).toBe(SPOT_CHECK_DARK_FACTORY_DEFAULT);
    expect(SPOT_CHECK_DARK_FACTORY_DEFAULT).toBe(10);
    expect(spotCheckShare("software_factory", tuning)).toBe(0);
    expect(spotCheckShare("assisted", tuning)).toBe(0);
    // A share that is set wins in either mode, 0 included.
    expect(spotCheckShare("software_factory", { spotCheckPercent: 25 })).toBe(25);
    expect(spotCheckShare("dark_factory", { spotCheckPercent: 0 })).toBe(0);
    // Tuning saved before the knob existed has none.
    expect(spotCheckShare("dark_factory", {})).toBe(10);
  });

  it("round-trips the tuning knob and keeps it out of patches that don't set it", () => {
    const tuned = FactoryTuning.parse({ spotCheckPercent: 30 });
    expect(FactoryTuning.parse(JSON.parse(JSON.stringify(tuned))).spotCheckPercent).toBe(30);
    for (const bad of [-1, 101, 12.5, "10"]) {
      expect(FactoryTuning.safeParse({ spotCheckPercent: bad }).success).toBe(false);
    }
    expect(FactoryTuningPatch.parse({ spotCheckPercent: null })).toEqual({
      spotCheckPercent: null,
    });
    expect(FactoryTuningPatch.parse({ maxFixAttempts: 1 })).not.toHaveProperty("spotCheckPercent");
    expect(
      SetAutonomyModeRequest.parse({ mode: "dark_factory", tuning: { spotCheckPercent: 0 } })
        .tuning,
    ).toEqual({ spotCheckPercent: 0 });
  });

  it("round-trips a spot-check and reads a pending one with defaults", () => {
    expect(SpotCheck.parse(JSON.parse(JSON.stringify(check)))).toEqual(check);
    expect(SpotCheck.parse({ reason: "large_change", state: "pending", sampledAt: ts })).toEqual({
      reason: "large_change",
      state: "pending",
      sampledAt: ts,
      checkedAt: null,
      note: null,
      issue: null,
    });
    expect(SpotCheck.safeParse({ ...check, reason: "random" }).success).toBe(false);
    expect(SpotCheck.safeParse({ ...check, state: "skipped" }).success).toBe(false);
    expect(
      SpotCheck.safeParse({ ...check, note: "x".repeat(SPOT_CHECK_NOTE_MAX + 1) }).success,
    ).toBe(false);
  });

  it("needs a note to record a problem, and files an issue by default", () => {
    expect(FactorySpotCheckRequest.parse({ verdict: "looks_good" })).toEqual({
      verdict: "looks_good",
    });
    expect(FactorySpotCheckRequest.parse({ verdict: "problem", note: " Broken " })).toEqual({
      verdict: "problem",
      note: "Broken",
      fileIssue: true,
    });
    expect(
      FactorySpotCheckRequest.parse({ verdict: "problem", note: "x", fileIssue: false }),
    ).toEqual({ verdict: "problem", note: "x", fileIssue: false });
    expect(FactorySpotCheckRequest.safeParse({ verdict: "problem" }).success).toBe(false);
    expect(FactorySpotCheckRequest.safeParse({ verdict: "problem", note: "  " }).success).toBe(
      false,
    );
    expect(FactorySpotCheckRequest.safeParse({ verdict: "maybe" }).success).toBe(false);
  });

  it("round-trips the panel's figures and lists, and reads old statuses and digests as none", () => {
    const spotChecks: FactorySpotChecks = {
      percent: 10,
      outstanding: 3,
      checked30d: 7,
      problems30d: 1,
      pending: [
        {
          ...entry,
          check: { ...check, state: "pending", checkedAt: null, note: null, issue: null },
        },
      ],
      recent: [entry, { ...entry, itemId: "i2", verdict: null }],
    };
    expect(FactorySpotChecks.parse(JSON.parse(JSON.stringify(spotChecks)))).toEqual(spotChecks);
    expect(FactorySpotChecks.parse({})).toEqual({
      percent: 0,
      outstanding: 0,
      checked30d: 0,
      problems30d: 0,
      pending: [],
      recent: [],
    });
    // A status or digest from a server before spot-checks.
    const status = FactoryStatus.shape.spotChecks.parse(undefined);
    expect(status.pending).toEqual([]);
    const digest = FactoryDigest.shape.spotChecks.parse(undefined);
    expect(digest).toEqual({
      checkedToday: 0,
      problemsToday: 0,
      outstanding: 0,
      checked30d: 0,
      problems30d: 0,
    });
  });

  it("has an inbox kind and a problem share", () => {
    expect(InboxItemKind.options).toContain("spot_check");
    expect(spotCheckProblemPercent(0, 0)).toBeNull();
    expect(spotCheckProblemPercent(7, 1)).toBe(14);
    expect(spotCheckProblemPercent(4, 4)).toBe(100);
  });
});
