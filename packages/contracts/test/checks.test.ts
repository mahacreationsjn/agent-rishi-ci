import { describe, expect, it } from "vitest";
import {
  CHECK_RUN_NOTICE,
  CheckRunData,
  checksOf,
  checkTimeoutMs,
  Item,
  ProjectChecksResponse,
  ProjectConfigFile,
  RunnerCommand,
  RunnerCommandResults,
  Session,
  StartSessionRequest,
  UpdateSessionRequest,
  UserInput,
} from "../src";
import { sampleSession } from "./fixtures";

const roundTrip = <T>(schema: { parse: (v: unknown) => T }, value: unknown): T =>
  schema.parse(JSON.parse(JSON.stringify(schema.parse(value))));

describe("project checks contracts", () => {
  it("reads checks from .agent-rishi/project.json as strings or definitions", () => {
    const config = roundTrip(ProjectConfigFile, {
      checks: ["pnpm typecheck", { command: "pnpm test", timeoutSec: 900 }],
    });
    expect(checksOf(config)).toEqual([
      { command: "pnpm typecheck" },
      { command: "pnpm test", timeoutSec: 900 },
    ]);
    expect(ProjectConfigFile.parse({}).checks).toEqual([]);
    expect(checksOf(null)).toEqual([]);
    expect(checkTimeoutMs({ command: "x" })).toBe(600_000);
    expect(checkTimeoutMs({ command: "x", timeoutSec: 5 })).toBe(5_000);
    expect(ProjectConfigFile.safeParse({ checks: "pnpm test" }).success).toBe(false);
    expect(ProjectConfigFile.safeParse({ checks: [""] }).success).toBe(false);
    expect(ProjectConfigFile.safeParse({ checks: [{ command: "x", timeoutSec: 0 }] }).success).toBe(
      false,
    );
    expect(ProjectConfigFile.safeParse({ checks: Array(21).fill("x") }).success).toBe(false);
  });

  it("carries the frozen checks and the loop setting on the session", () => {
    const checks = {
      commands: [{ command: "pnpm test", timeoutSec: 60 }],
      untilPass: true,
      maxRounds: 3,
    };
    expect(roundTrip(Session, { ...sampleSession, checks }).checks).toEqual(checks);
    expect(roundTrip(Session, sampleSession).checks).toBeUndefined();
    expect(roundTrip(Session, { ...sampleSession, checks: null }).checks).toBeNull();
    expect(
      Session.safeParse({ ...sampleSession, checks: { ...checks, maxRounds: 11 } }).success,
    ).toBe(false);
    // The round count lives beside them (#412).
    const counted = { ...checks, round: 3, capReached: true };
    expect(roundTrip(Session, { ...sampleSession, checks: counted }).checks).toEqual(counted);
    expect(Session.safeParse({ ...sampleSession, checks: { ...checks, round: 0 } }).success).toBe(
      false,
    );
  });

  it("turns the loop on when a session starts and with PATCH", () => {
    const start = roundTrip(StartSessionRequest, {
      projectId: "p1",
      untilChecksPass: true,
      checkRounds: 5,
    });
    expect(start).toMatchObject({ untilChecksPass: true, checkRounds: 5 });
    expect(StartSessionRequest.safeParse({ projectId: "p1", checkRounds: 0 }).success).toBe(false);
    expect(roundTrip(UpdateSessionRequest, { untilChecksPass: false })).toEqual({
      untilChecksPass: false,
    });
    expect(roundTrip(UpdateSessionRequest, { checkRounds: 2 })).toEqual({ checkRounds: 2 });
    // The commands never come from a request.
    expect(roundTrip(UpdateSessionRequest, { checkRounds: 2, checks: ["rm -rf /"] })).toEqual({
      checkRounds: 2,
    });
  });

  it("marks the loop's own message with its round", () => {
    const input = roundTrip(UserInput, { text: "fix", from: "agent-rishi", checksRound: 2 });
    expect(input.checksRound).toBe(2);
    expect(UserInput.safeParse({ text: "x", checksRound: 0 }).success).toBe(false);
  });

  it("describes a check run's card as a typed notice", () => {
    const data = {
      round: 1,
      maxRounds: 3,
      checks: [
        { command: "pnpm typecheck", status: "passed", exitCode: 0, durationMs: 1200 },
        {
          command: "pnpm test",
          status: "failed",
          exitCode: 1,
          durationMs: 5300,
          output: "1 failed",
          truncated: true,
        },
      ],
      outcome: "continuing",
    };
    expect(roundTrip(CheckRunData, data)).toEqual(data);
    const item = roundTrip(Item, {
      id: "checks-t1",
      kind: "notice",
      status: "completed",
      level: "warning",
      code: CHECK_RUN_NOTICE,
      message: "1 of 2 checks failed",
      data,
    });
    expect(item.kind === "notice" && CheckRunData.parse(item.data).outcome).toBe("continuing");
    expect(CheckRunData.safeParse({ ...data, checks: [] }).success).toBe(false);
    expect(CheckRunData.safeParse({ ...data, outcome: "maybe" }).success).toBe(false);
  });

  it("runs and cancels a check on the runner", () => {
    const run = {
      name: "check.run" as const,
      sessionId: "s1",
      cwd: "/wt/s1",
      command: "pnpm test",
      timeoutMs: 600_000,
      ciEnv: false,
    };
    expect(roundTrip(RunnerCommand, run)).toEqual(run);
    expect(RunnerCommand.safeParse({ ...run, timeoutMs: 0 }).success).toBe(false);
    const cancel = { name: "check.cancel" as const, sessionId: "s1" };
    expect(roundTrip(RunnerCommand, cancel)).toEqual(cancel);
    const result = {
      exitCode: null,
      timedOut: true,
      cancelled: false,
      durationMs: 10,
      output: "slow",
      truncated: false,
    };
    expect(roundTrip(RunnerCommandResults["check.run"], result)).toEqual(result);
    expect(roundTrip(RunnerCommandResults["check.cancel"], { cancelled: true })).toEqual({
      cancelled: true,
    });
  });

  it("lists a project's checks for the new-session view", () => {
    const body = { checks: [{ command: "pnpm lint" }] };
    expect(roundTrip(ProjectChecksResponse, body)).toEqual(body);
  });
});
