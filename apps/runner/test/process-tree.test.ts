import { describe, expect, it } from "vitest";
import {
  killTreeAndOrphans,
  type ProcessEntry,
  parseProcessRows,
  type TreeOps,
  treeIn,
} from "../src/process/tree";

/**
 * Finding what a process started (#412). On Windows a process keeps the pid of a parent that
 * exited, and pids are reused: processes naming a pid as their parent may have been started by
 * an earlier process that had it, and must never be killed with it.
 */

const row = (pid: number, ppid: number, startedAt: number | null): ProcessEntry => ({
  pid,
  ppid,
  startedAt,
});

/** A check's shell, pid 100, alive from 10 s to 20 s after the epoch; it has exited. */
const life = { startedAt: 10_000, endedAt: 20_000 };
const rows = [
  // An earlier process with pid 100 started these (a browser, a sync client); its pid was reused.
  row(200, 100, 5_000),
  row(201, 200, 6_000),
  // What the shell started, and what that started in turn.
  row(300, 100, 12_000),
  row(301, 300, 13_000),
  // An earlier process with pid 300 started this one.
  row(302, 300, 11_000),
  // A later process with pid 100 started this one, after the shell exited.
  row(400, 100, 25_000),
  // No start time to check.
  row(500, 100, null),
  // Reported a clock tick before the spawn time taken in Node.
  row(600, 100, 9_990),
];

describe("treeIn", () => {
  it("on Windows, follows a parent id only to processes started during the parent's life", () => {
    expect(treeIn(rows, 100, { checkStarts: true, root: life })).toEqual([300, 600, 301]);
  });

  it("takes a running root's start from the table, and finds nothing for an unknown one", () => {
    const running = [row(100, 1, 10_000), ...rows];
    expect(treeIn(running, 100, { checkStarts: true })).toEqual([300, 400, 301]);
    expect(treeIn(rows, 100, { checkStarts: true })).toEqual([]);
  });

  it("follows parent ids as they are where orphans get a new parent (POSIX)", () => {
    expect(treeIn(rows, 100, { checkStarts: false })).toEqual([
      200, 300, 400, 500, 600, 201, 301, 302,
    ]);
  });

  it("parses the table with or without start times", () => {
    expect(parseProcessRows("  10   1 1794586311875\r\n11 10\nbad\n")).toEqual([
      row(10, 1, 1794586311875),
      row(11, 10, null),
    ]);
  });
});

describe("killTreeAndOrphans on Windows", () => {
  const ops = (alive: boolean, killed: number[]): TreeOps => ({
    platform: "win32",
    table: async () => rows,
    isAlive: () => alive,
    now: () => 20_000,
    killTree: async () => {
      throw new Error("never taskkill /T on Windows");
    },
    killProcess: (pid) => killed.push(pid),
    killGroup: () => {
      throw new Error("no process groups on Windows");
    },
  });

  it("never kills a process an earlier owner of the pid started", async () => {
    const killed: number[] = [];
    await killTreeAndOrphans(100, life, { ops: ops(true, killed) });
    // The shell was seen exiting: its pid is no longer its own, so only what it started goes.
    expect(killed).toEqual([300, 600, 301]);
  });

  it("ends a running process first, then what it started before that", async () => {
    const killed: number[] = [];
    await killTreeAndOrphans(100, { startedAt: 10_000 }, { ops: ops(true, killed) });
    expect(killed).toEqual([100, 300, 600, 301]);
  });
});
