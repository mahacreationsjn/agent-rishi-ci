import { FactoryItem } from "@agent-rishi/contracts";
import { screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { SpecApprovalCard } from "@/components/factory/spec-approval";
import { renderWithClient } from "./utils";

/**
 * Issue #365: after a person asked for changes to a spec, a revised analysis that decides not to
 * build it stops the item. Its page shows that decision, not "the agent revises its analysis".
 */

const asked = "2026-11-14T08:00:00.000Z";
const revised = "2026-11-14T08:20:00.000Z";

const item = (patch: Partial<FactoryItem>): FactoryItem =>
  FactoryItem.parse({
    id: "item-1",
    projectId: "p-app",
    workKey: "issue:170",
    title: "Add CSV export",
    summary: "Export the tasks",
    source: "issue",
    area: null,
    acceptanceCriteria: [],
    score: null,
    stage: "building",
    type: "feature",
    issue: { number: 170, url: "https://github.com/acme/app/issues/170" },
    pr: null,
    builderSessionId: "s-1",
    builderProvider: "claude",
    reviewerSessionId: null,
    reviewerProvider: null,
    reviewerNote: null,
    review: null,
    checks: [],
    attempts: 0,
    reason: null,
    note: null,
    mergeSha: null,
    revertOf: null,
    triageRequestedAt: null,
    investigation: {
      kind: "analysis",
      outcome: "implement",
      summary: "No export yet",
      details: "An Export button that downloads the tasks as CSV",
      testPath: null,
      at: "2026-11-14T07:50:00.000Z",
    },
    specApproval: {
      state: "changes_requested",
      requestedAt: "2026-11-14T07:50:00.000Z",
      decidedAt: asked,
      by: "user",
      feedback: "Also offer JSON",
      rounds: 1,
      sentAt: asked,
    },
    createdAt: "2026-11-14T07:00:00.000Z",
    updatedAt: revised,
    mergedAt: null,
    finishedAt: null,
    ...patch,
  });

const card = () => screen.getByTestId("spec-approval").textContent ?? "";

describe("the spec card after a request for changes (#365)", () => {
  it("says the agent revises the spec while it does", () => {
    renderWithClient(<SpecApprovalCard item={item({})} projectId="p-app" />);
    expect(card()).toMatch(/the agent revises its analysis/);
  });

  it("shows the final decision once the revised analysis decided not to build it", () => {
    const stopped = item({
      stage: "rejected",
      reason: "Out of scope for the vision: JSON export doesn't fit the vision",
      finishedAt: revised,
      investigation: {
        kind: "analysis",
        outcome: "out_of_scope",
        summary: "JSON export doesn't fit the vision",
        details: null,
        testPath: null,
        at: revised,
      },
    });
    renderWithClient(<SpecApprovalCard item={stopped} projectId="p-app" />);
    expect(card()).not.toMatch(/revises its analysis/);
    expect(card()).toMatch(/decided not to build it/i);
    expect(card()).toMatch(/out of scope/i);
    expect(card()).toContain("Also offer JSON");
  });
});
