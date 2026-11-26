import type { ProviderCapabilities, ProviderInfo, Session } from "@agent-rishi/contracts";
import { describe, expect, it } from "vitest";
import { makeSession } from "@/lib/api/mock/fixtures/helpers";
import {
  appliedNote,
  planLevelChanges,
  raisesLevel,
  sessionsKeepingLevel,
} from "@/lib/project-permissions";

const session = (id: string, over: Partial<Session> = {}) =>
  makeSession({
    id,
    role: "agent",
    status: "running",
    provider: "fake",
    purpose: id,
    workKey: `request:${id}`,
    projectId: "p1",
    autonomy: "supervised",
    ...over,
  });

const caps = (liveAutonomy?: boolean): ProviderCapabilities => ({
  resume: true,
  steer: true,
  interrupt: true,
  approvals: true,
  userQuestions: true,
  subagents: false,
  rollback: false,
  fork: false,
  images: false,
  planMode: false,
  reasoningEffort: false,
  mcp: true,
  skills: false,
  ...(liveAutonomy === undefined ? {} : { liveAutonomy }),
});
const provider = (id: string, liveAutonomy?: boolean): ProviderInfo => ({
  id,
  displayName: id,
  capabilities: caps(liveAutonomy),
  models: [],
});
// Named so nothing can lean on a real provider's id: only the capability decides.
const providers = [provider("live", true), provider("per-turn", false), provider("unreported")];

describe("sessionsKeepingLevel", () => {
  it("names the project's open agent sessions on another level", () => {
    const sessions = [
      session("s-running"),
      session("s-idle", { status: "idle", autonomy: "full" }),
      session("s-same", { autonomy: "auto" }),
      session("s-other-project", { projectId: "p2" }),
      session("s-pm", { role: "pm" }),
      session("s-archived", { archivedAt: "2026-01-01T00:00:00.000Z" }),
      session("s-stopped", { status: "stopped" }),
      session("s-completed", { status: "completed" }),
      session("s-failed", { status: "failed" }),
    ];
    expect(sessionsKeepingLevel(sessions, "p1", "auto").map((s) => s.id)).toEqual([
      "s-running",
      "s-idle",
    ]);
  });

  it("names none once the sessions are on the project's level", () => {
    expect(sessionsKeepingLevel([session("s1")], "p1", "supervised")).toEqual([]);
  });
});

describe("raisesLevel", () => {
  it("orders the levels from Read-only to Full", () => {
    expect(raisesLevel("auto", "full")).toBe(true);
    expect(raisesLevel("read_only", "supervised")).toBe(true);
    expect(raisesLevel("supervised", "auto")).toBe(true);
    expect(raisesLevel("full", "auto")).toBe(false);
    expect(raisesLevel("supervised", "read_only")).toBe(false);
    expect(raisesLevel("auto", "auto")).toBe(false);
  });
});

describe("planLevelChanges", () => {
  it("marks the sessions the project's level raises, which need confirming", () => {
    const keeping = [
      session("s-ro", { autonomy: "read_only" }),
      session("s-auto", { autonomy: "auto" }),
      session("s-full", { autonomy: "full" }),
    ];
    const plan = planLevelChanges(keeping, "auto", providers);
    expect(plan.map((c) => [c.session.id, c.from, c.to, c.raises])).toEqual([
      ["s-ro", "read_only", "auto", true],
      ["s-full", "full", "auto", false],
    ]);
  });

  it("needs no confirmation when it only lowers", () => {
    const keeping = [session("a", { autonomy: "full" }), session("b", { autonomy: "auto" })];
    expect(planLevelChanges(keeping, "supervised", providers).some((c) => c.raises)).toBe(false);
  });

  it("never changes the orchestrator or a PM", () => {
    const keeping = [
      session("pm", { role: "pm", autonomy: "auto" }),
      session("orchestrator", { role: "orchestrator", autonomy: "auto" }),
    ];
    expect(planLevelChanges(keeping, "full", providers)).toEqual([]);
  });

  it("reads when it applies from the provider's liveAutonomy", () => {
    const keeping = [
      session("a", { provider: "live" }),
      session("b", { provider: "per-turn" }),
      session("c", { provider: "unreported" }),
      session("d", { provider: "not-loaded" }),
    ];
    expect(planLevelChanges(keeping, "auto", providers).map((c) => c.appliesFrom)).toEqual([
      "next_tool_call",
      "next_turn",
      "next_turn",
      "next_turn",
    ]);
  });
});

describe("appliedNote", () => {
  const plan = (...sessions: Session[]) => planLevelChanges(sessions, "full", providers);

  it("says when the level takes effect", () => {
    expect(appliedNote(plan(session("a", { provider: "live" })))).toBe(
      "It applies from the agent's next tool call.",
    );
    expect(
      appliedNote(plan(session("a", { provider: "per-turn" }), session("b", { provider: "x" }))),
    ).toBe("It applies from each session's next turn.");
    expect(
      appliedNote(
        plan(
          session("a", { provider: "live" }),
          session("b", { provider: "live" }),
          session("c", { provider: "per-turn" }),
        ),
      ),
    ).toBe("It applies from the next tool call in 2 sessions and from the next turn in 1 session.");
  });

  it("says that requests already waiting stay waiting", () => {
    expect(appliedNote(plan(session("a", { provider: "live", status: "waiting" })))).toBe(
      "It applies from the agent's next tool call. Approvals and questions already waiting for you stay waiting.",
    );
  });
});
