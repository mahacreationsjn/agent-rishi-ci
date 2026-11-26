import { describe, expect, it } from "vitest";
import {
  AutonomyMode,
  FactoryAnalysisReport,
  FactoryFileIssueRequest,
  FactoryLimits,
  FactorySpecDecisionRequest,
  type Investigation,
  Project,
  pipelineStep,
  ScoutRound,
  ScoutState,
  SPEC_FEEDBACK_MAX,
  SpecApproval,
  type SpecApprovalState,
  specHeld,
} from "../src";
import { sampleProject, ts } from "./fixtures";

const base = {
  stage: "building",
  type: "bug" as const,
  investigation: null as Investigation | null,
  checks: [] as Array<{ state: string }>,
  review: null,
};
const reproduced: Investigation = {
  kind: "reproduction",
  outcome: "reproduced",
  summary: "Throws",
  details: null,
  testPath: "test/a.test.ts",
  at: ts,
};

describe("factory pipelines (§10.1)", () => {
  it("reads the old `autopilot` mode as the software factory", () => {
    expect(AutonomyMode.parse("autopilot")).toBe("software_factory");
    expect(Project.parse({ ...sampleProject, autonomyMode: "autopilot" }).autonomyMode).toBe(
      "software_factory",
    );
    expect(AutonomyMode.safeParse("yolo").success).toBe(false);
  });

  it("defaults to manual merging and no trusted authors besides the GitHub account", () => {
    const limits = FactoryLimits.parse({});
    expect(limits.autoMerge).toBe(false);
    expect(limits.trustedAuthors).toEqual([]);
    expect(FactoryLimits.parse({ trustedAuthors: ["@octocat"] }).trustedAuthors).toEqual([
      "octocat",
    ]);
  });

  it("puts each item at its pipeline step", () => {
    expect(pipelineStep({ ...base, stage: "candidate" })).toBe("intake");
    expect(pipelineStep({ ...base, stage: "ignored" })).toBe("ignored");
    expect(pipelineStep({ ...base, stage: "backlog" })).toBe("queued");
    expect(pipelineStep(base)).toBe("reproduce");
    expect(pipelineStep({ ...base, type: "feature" })).toBe("analyze");
    expect(pipelineStep({ ...base, type: "docs" })).toBe("implement");
    expect(pipelineStep({ ...base, investigation: reproduced })).toBe("implement");
    const verifying = { ...base, stage: "verifying", investigation: reproduced };
    expect(pipelineStep({ ...verifying, checks: [{ state: "pending" }] })).toBe("review");
    expect(pipelineStep({ ...verifying, checks: [{ state: "fail" }] })).toBe("review");
    expect(pipelineStep({ ...verifying, checks: [{ state: "pass" }, { state: "skipped" }] })).toBe(
      "merge",
    );
    expect(pipelineStep({ ...base, stage: "escalated" })).toBe("merge");
    expect(pipelineStep({ ...base, stage: "merged" })).toBe("done");
    expect(pipelineStep({ ...base, stage: "failed" })).toBe("stopped");
  });

  it("keeps a feature at Analyze while its spec waits for a person or is revised", () => {
    const analyzed = { ...base, type: "feature" as const, investigation: reproduced };
    const at = (state: SpecApprovalState) => pipelineStep({ ...analyzed, specApproval: { state } });
    expect(at("pending")).toBe("analyze");
    expect(at("changes_requested")).toBe("analyze");
    expect(at("approved")).toBe("implement");
    expect(pipelineStep({ ...analyzed, specApproval: null })).toBe("implement");
    expect(specHeld({ specApproval: { state: "pending" } })).toBe(true);
    expect(specHeld({ specApproval: null })).toBe(false);
  });

  it("round-trips a spec's approval and validates a person's decision", () => {
    const pending = SpecApproval.parse({ state: "pending", requestedAt: ts });
    expect(pending).toEqual({
      state: "pending",
      requestedAt: ts,
      decidedAt: null,
      by: null,
      feedback: null,
      rounds: 0,
      sentAt: null,
    });
    const asked = {
      ...pending,
      state: "changes_requested" as const,
      decidedAt: ts,
      by: "user" as const,
      feedback: "Export JSON too",
      rounds: 1,
    };
    expect(SpecApproval.parse(JSON.parse(JSON.stringify(asked)))).toEqual(asked);
    expect(SpecApproval.safeParse({ ...asked, state: "rejected" }).success).toBe(false);
    expect(
      SpecApproval.safeParse({ ...asked, feedback: "x".repeat(SPEC_FEEDBACK_MAX + 1) }).success,
    ).toBe(false);
    expect(FactorySpecDecisionRequest.parse({ decision: "approve" })).toEqual({
      decision: "approve",
    });
    expect(
      FactorySpecDecisionRequest.parse({ decision: "request_changes", feedback: "  Add JSON  " }),
    ).toEqual({ decision: "request_changes", feedback: "Add JSON" });
    // The version shown travels with the decision.
    const versioned = { decision: "request_changes" as const, feedback: "Add JSON", version: ts };
    expect(FactorySpecDecisionRequest.parse(JSON.parse(JSON.stringify(versioned)))).toEqual(
      versioned,
    );
    // Asking for changes needs to say which.
    for (const bad of [
      { decision: "request_changes" },
      { decision: "request_changes", feedback: "   " },
      { decision: "reject" },
      { decision: "approve", version: "yesterday" },
    ]) {
      expect(FactorySpecDecisionRequest.safeParse(bad).success).toBe(false);
    }
  });

  it("validates the builder's and the scout's reports", () => {
    expect(
      FactoryAnalysisReport.safeParse({ decision: "implement", summary: "Missing" }).success,
    ).toBe(false);
    expect(
      FactoryAnalysisReport.safeParse({ decision: "out_of_scope", summary: "Not for us" }).success,
    ).toBe(true);
    const filed = FactoryFileIssueRequest.parse({
      title: "Add CSV export",
      summary: "Users ask for it",
      type: "feature",
      acceptanceCriteria: ["Exports"],
    });
    expect(filed.priority).toBe("normal");
    expect(FactoryFileIssueRequest.safeParse({ ...filed, type: "chore" }).success).toBe(false);
    expect(ScoutState.parse({}).lensSessions).toEqual({});
    // A round saved before the work-in-progress limit reads as never held.
    const round = {
      id: "r1",
      phase: "reviewing",
      startedAt: "2026-11-13T00:00:00.000Z",
      sentAt: "2026-11-13T00:00:00.000Z",
    } as const;
    expect(ScoutRound.parse(round)).toMatchObject({ heldSince: null, heldMs: 0 });
    const held = ScoutRound.parse({
      ...round,
      heldSince: "2026-11-13T04:00:00.000Z",
      heldMs: 7_200_000,
    });
    expect(ScoutRound.parse(JSON.parse(JSON.stringify(held)))).toEqual(held);
    expect(ScoutRound.safeParse({ ...round, heldMs: -1 }).success).toBe(false);
  });

  it("keeps the scout's plan and why a round closed early", () => {
    const round = { id: "r1", phase: "planning", startedAt: ts, sentAt: ts } as const;
    // Rounds and scouts saved before plans were recorded read as unplanned, with no note.
    expect(ScoutRound.parse(round).plan).toBeNull();
    expect(ScoutState.parse({}).lastRoundNote).toBeNull();
    const plan = {
      at: ts,
      lenses: [{ area: "ux", focus: "the task editor" }],
      pending: ["ux"],
      next: "End your turn now.",
    };
    const planned = ScoutRound.parse({ ...round, plan });
    expect(ScoutRound.parse(JSON.parse(JSON.stringify(planned)))).toEqual(planned);
    expect(ScoutRound.safeParse({ ...round, plan: { ...plan, pending: ["nope"] } }).success).toBe(
      false,
    );
    const closed = ScoutState.parse({ lastRoundNote: "Couldn't start area reviewers (ux)." });
    expect(ScoutState.parse(JSON.parse(JSON.stringify(closed)))).toEqual(closed);
  });
});
