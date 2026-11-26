import {
  FactoryLimits,
  FactoryStatus,
  FactoryWorkItem,
  type Session,
} from "@agent-rishi/contracts";
import { screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { ProjectActivity, projectActivity } from "@/components/factory-view/project-activity";
import { createMockClient } from "@/lib/api/mock";
import { sessionWork } from "@/lib/orchestration";
import { renderWithClient } from "./utils";

const at = "2026-11-26T08:00:00.000Z";
const issue = { number: 42, url: "https://github.com/acme/shop/issues/42" };
const pr = {
  number: 43,
  title: "Fix cart",
  state: "open" as const,
  url: "https://github.com/acme/shop/pull/43",
};
const status = (patch: Partial<FactoryStatus> = {}) =>
  FactoryStatus.parse({
    projectId: "p1",
    mode: "software_factory",
    experimental: true,
    loopState: "idle",
    pausedReason: null,
    killSwitch: false,
    globalKillSwitch: false,
    limits: FactoryLimits.parse({ dailyBudget: { usd: 20 } }),
    tuning: {},
    spendToday: { usd: 0, tokens: 0 },
    mergesToday: 0,
    consecutiveFailures: 0,
    activeSessions: 0,
    backlog: [],
    inProgress: [],
    mergeChecks: [],
    recent: [],
    visionExists: true,
    lastDigest: null,
    lastTickAt: null,
    ...patch,
  });
const session = (id: string, patch: Partial<Session> = {}): Session =>
  ({
    id,
    projectId: "p1",
    role: "agent",
    startedBy: { kind: "pm" },
    purpose: id,
    workKey: `request:${id}`,
    scope: { projectId: "p1" },
    progress: null,
    title: id,
    status: "running",
    createdAt: at,
    issue: null,
    pr: null,
    ...patch,
  }) as Session;

describe("Factory view project activity", () => {
  it("separates project work from an empty factory and links to the existing owner", async () => {
    const builder = session("cart-builder", { issue, pr });
    renderWithClient(
      <ProjectActivity
        factory={status()}
        work={[sessionWork(builder)]}
        sessions={[builder]}
        loaded
        refreshing={false}
      />,
      createMockClient(),
      { withRouter: true },
    );
    expect(await screen.findByText("No factory-owned work in progress")).toBeTruthy();
    expect(
      screen.getByRole("link", { name: "View project activity" }).getAttribute("href"),
    ).toContain("#project-now");
    expect(
      screen.getByRole("link", { name: "Work session: cart-builder" }).getAttribute("href"),
    ).toBe("/sessions/cart-builder");
    expect(screen.getByRole("link", { name: "Issue #42" })).toBeTruthy();
    expect(screen.getByRole("link", { name: "PR #43" })).toBeTruthy();
  });

  it("shows loading before confirming that the project is idle", () => {
    renderWithClient(
      <ProjectActivity factory={status()} work={[]} sessions={[]} loaded={false} refreshing />,
      createMockClient(),
    );
    expect(screen.getByText("Checking project activity…")).toBeTruthy();
    expect(screen.queryByText("No active project work")).toBeNull();
  });

  it("shows a different message after confirming that both scopes are idle", () => {
    renderWithClient(
      <ProjectActivity factory={status()} work={[]} sessions={[]} loaded refreshing={false} />,
      createMockClient(),
    );
    expect(screen.getByText("No active project work")).toBeTruthy();
  });

  it("uses a handoff or review session as the single owner and drops completed activity", () => {
    const builder = session("builder", { issue, pr });
    const handoff = session("handoff", {
      issue,
      pr,
      forkedFrom: { kind: "handoff", sessionId: builder.id, checkpoint: null },
    });
    const reviewer = session("reviewer", {
      forkedFrom: { kind: "review", sessionId: handoff.id, checkpoint: null },
    });
    const work = [builder, handoff, reviewer].map(sessionWork);
    expect(
      projectActivity(status(), work, [builder, handoff, reviewer]).map((a) => a.work.id),
    ).toEqual(["reviewer"]);
    const done = { ...reviewer, status: "idle" as const };
    expect(projectActivity(status(), work, [builder, handoff, done]).map((a) => a.work.id)).toEqual(
      ["handoff"],
    );
  });

  it("uses explicit Factory ownership instead of treating every issue link as Factory work", () => {
    const projectOwner = session("project-owner", { issue, pr });
    const factoryOwner = session("factory-owner", { issue });
    const item = FactoryWorkItem.parse({
      id: "item",
      title: "Cart",
      workKey: "issue:42",
      issue,
      pr: null,
      score: null,
      sessionId: factoryOwner.id,
      stage: "verifying",
      source: "issue",
      reason: null,
      note: null,
      updatedAt: at,
    });
    const work = [projectOwner, factoryOwner].map(sessionWork);
    expect(
      projectActivity(status({ inProgress: [item] }), work, [projectOwner, factoryOwner]).map(
        (a) => a.work.id,
      ),
    ).toEqual(["project-owner"]);
    const takenOver = { ...item, ownedPr: pr };
    expect(
      projectActivity(status({ inProgress: [takenOver] }), work, [projectOwner, factoryOwner]),
    ).toEqual([]);
  });
});
