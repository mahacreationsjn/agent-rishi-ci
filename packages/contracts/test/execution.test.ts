import { describe, expect, it } from "vitest";
import {
  BackendStatus,
  describeUnpushedWork,
  ExecutionBackendsResponse,
  hasUnpushedWork,
  Project,
  ProjectExecutionBackend,
  ProviderCapabilities,
  RunnerCommand,
  RunnerCommandResults,
  SandboxRef,
  SandboxSpec,
  SandboxSummary,
  sandboxRefFor,
  UnpushedWork,
  UpdateProjectRequest,
  WorktreeCleanupOutcome,
} from "../src";
import { sampleProject } from "./fixtures";

function roundTrip<T>(schema: { parse: (v: unknown) => T }, value: unknown): T {
  const first = schema.parse(value);
  const second = schema.parse(JSON.parse(JSON.stringify(first)));
  expect(second).toEqual(first);
  return second;
}

// Remote runners phase 4a (#309): a project's agent sessions can run in Docker containers.
describe("execution backends", () => {
  it("defaults a project to local, so projects from before the setting still parse", () => {
    const { execution: _e, ...rest } = sampleProject;
    expect(Project.parse(rest).execution).toEqual({ backend: "local" });
    expect(Project.parse({ ...rest, execution: {} }).execution).toEqual({ backend: "local" });
  });

  it("round-trips a docker project and refuses unknown backends", () => {
    const project = roundTrip(Project, { ...sampleProject, execution: { backend: "docker" } });
    expect(project.execution.backend).toBe("docker");
    expect(Project.safeParse({ ...sampleProject, execution: { backend: "vm" } }).success).toBe(
      false,
    );
    expect(ProjectExecutionBackend.options).toEqual(["local", "docker"]);
  });

  it("is changed through the project update request", () => {
    const patch = { execution: { backend: "docker" } };
    expect(roundTrip(UpdateProjectRequest, patch)).toEqual(patch);
    expect(UpdateProjectRequest.safeParse({ execution: { backend: "upstash" } }).success).toBe(
      false,
    );
  });

  it("round-trips backend statuses and the API response", () => {
    const docker: BackendStatus = {
      backend: "docker",
      available: false,
      code: "daemon_down",
      version: null,
      reason: "Docker is installed but its daemon isn't running",
      fix: "Start Docker Desktop (or the docker service), then check again",
    };
    roundTrip(BackendStatus, docker);
    const local = { ...docker, backend: "local", available: true, code: "ok", reason: null };
    roundTrip(ExecutionBackendsResponse, { backends: [local, docker] });
    expect(BackendStatus.safeParse({ ...docker, code: "broken" }).success).toBe(false);
  });

  it("round-trips sandbox specs, references and summaries", () => {
    const spec = roundTrip(SandboxSpec, {
      recordId: "3f2a1b4c-9d8e7f",
      sessionId: "s1",
      projectId: "p1",
      image: "agent-rishi-runner:0.7.2",
      cpus: 2,
      memoryMb: 4096,
    });
    expect(spec.fake).toBe(false);
    expect(SandboxSpec.safeParse({ ...spec, memoryMb: 0 }).success).toBe(false);
    const ref = roundTrip(SandboxRef, sandboxRefFor("agent-rishi-3f2a1b4c-9d8e7f"));
    expect(ref).toEqual({
      backend: "docker",
      container: "agent-rishi-3f2a1b4c-9d8e7f",
      volume: "agent-rishi-3f2a1b4c-9d8e7f-data",
    });
    roundTrip(SandboxSummary, {
      container: ref.container,
      volume: ref.volume,
      sessionId: "s1",
      projectId: "p1",
      recordId: "3f2a1b4c-9d8e7f",
      version: "0.7.2",
      state: "exited",
    });
  });

  // #337: a container's clone is the only copy of what it hasn't pushed.
  it("round-trips what exists only in a clone, its runner command and the archive outcome", () => {
    expect(RunnerCommand.parse({ name: "git.unpushed", cwd: "/data/ws/s1" })).toEqual({
      name: "git.unpushed",
      cwd: "/data/ws/s1",
    });
    const work = roundTrip(RunnerCommandResults["git.unpushed"], {
      current: "agent-rishi/fix",
      uncommitted: 3,
      branches: [{ name: "agent-rishi/fix", commits: 2 }],
      stashes: 1,
    });
    expect(UnpushedWork.safeParse({ ...work, branches: [{ name: "x", commits: 0 }] }).success).toBe(
      false,
    );
    const kept = roundTrip(WorktreeCleanupOutcome, {
      status: "kept_changes",
      message: "kept",
      unpushed: work,
    });
    expect(kept.unpushed).toEqual(work);
    // Outcomes from before it existed still parse.
    expect(WorktreeCleanupOutcome.parse({ status: "removed", message: null }).unpushed).toBe(
      undefined,
    );
  });

  it("describes unpushed work in a few words", () => {
    const none = { current: "main", uncommitted: 0, branches: [], stashes: 0 };
    expect(hasUnpushedWork(none)).toBe(false);
    expect(describeUnpushedWork(none)).toBe("");
    const one = { ...none, branches: [{ name: "agent-rishi/fix", commits: 1 }] };
    expect(hasUnpushedWork(one)).toBe(true);
    expect(describeUnpushedWork(one)).toBe("1 unpushed commit on agent-rishi/fix");
    expect(
      describeUnpushedWork({
        current: null,
        uncommitted: 3,
        branches: [
          { name: "agent-rishi/fix", commits: 2 },
          { name: "HEAD", commits: 1 },
        ],
        stashes: 2,
      }),
    ).toBe(
      "2 unpushed commits on agent-rishi/fix, 1 unpushed commit on a detached HEAD, uncommitted changes in 3 files and 2 stashes",
    );
    expect(describeUnpushedWork({ ...none, stashes: 1 })).toBe("1 stash");
  });

  it("marks providers that need no credentials (absent: they need some)", () => {
    const base = {
      resume: true,
      steer: true,
      interrupt: true,
      approvals: true,
      userQuestions: false,
      subagents: false,
      rollback: false,
      fork: false,
      images: false,
      planMode: false,
      reasoningEffort: false,
      mcp: true,
      skills: false,
    };
    expect(ProviderCapabilities.parse(base).credentialFree).toBeUndefined();
    expect(roundTrip(ProviderCapabilities, { ...base, credentialFree: true }).credentialFree).toBe(
      true,
    );
  });
});
