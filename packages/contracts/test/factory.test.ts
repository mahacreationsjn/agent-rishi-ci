import { describe, expect, it } from "vitest";
import { FactoryLimits, FactoryLoopState, Project, Settings } from "../src";
import { sampleProject } from "./fixtures";

describe("autonomy modes and dark factory (§10.1)", () => {
  it("defaults projects to assisted with safe limits", () => {
    const {
      autonomyMode: _m,
      visionPath: _v,
      factoryLimits: _l,
      killSwitch: _k,
      ...rest
    } = sampleProject;
    const project = Project.parse(rest);
    expect(project.autonomyMode).toBe("assisted");
    expect(project.visionPath).toBe(".agent-rishi/VISION.md");
    expect(project.killSwitch).toBe(false);
    expect(project.factoryLimits.allowDeploys).toBe(false);
    expect(project.factoryLimits.dailyBudget).toEqual({});
    expect(project.factoryLimits.protectedPaths).toEqual([]);
  });

  it("validates limits and loop states", () => {
    expect(FactoryLimits.safeParse({ maxConcurrentSessions: 0 }).success).toBe(false);
    expect(FactoryLimits.parse({ dailyBudget: { tokens: 1_000_000 } }).dailyBudget.tokens).toBe(
      1_000_000,
    );
    expect(FactoryLoopState.options).toContain("verifying");
    expect(Project.safeParse({ ...sampleProject, autonomyMode: "yolo" }).success).toBe(false);
  });

  it("defaults the merge policy to fast and round-trips strict (#301)", () => {
    // Limits saved before the policy existed merge fast.
    expect(FactoryLimits.parse({}).mergePolicy).toBe("fast");
    const { mergePolicy: _p, ...saved } = sampleProject.factoryLimits;
    expect(
      Project.parse({ ...sampleProject, factoryLimits: saved }).factoryLimits.mergePolicy,
    ).toBe("fast");
    const strict = FactoryLimits.parse({ autoMerge: true, mergePolicy: "strict" });
    expect(FactoryLimits.parse(JSON.parse(JSON.stringify(strict)))).toEqual(strict);
    expect(strict.mergePolicy).toBe("strict");
    expect(FactoryLimits.safeParse({ mergePolicy: "yolo" }).success).toBe(false);
  });

  it("has a global kill switch in settings, off by default", () => {
    expect(Settings.parse({}).factory.killSwitch).toBe(false);
  });
});
