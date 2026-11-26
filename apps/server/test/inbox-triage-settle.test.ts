import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { InboxItem } from "@agent-rishi/contracts";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type RunningServer, startServer } from "../src";
import { TriageSettler } from "../src/services/automations/triage-settle";
import { removeTree } from "./support/remove-tree";

/** Triage decisions resolve once their issue closes on GitHub (#673). */

let home: string;
let server: RunningServer;

beforeEach(async () => {
  home = mkdtempSync(join(tmpdir(), "agent-rishi-triage-settle-"));
  server = await startServer({
    port: 0,
    dataDir: join(home, "data"),
    token: "c".repeat(64),
    runner: false,
    secrets: "memory",
    checkSetupOnStart: false,
  });
});

afterEach(async () => {
  await server.close();
  await removeTree(home);
});

function triage(id: string, number: number, extra: Partial<InboxItem> = {}): InboxItem {
  const at = new Date(Date.UTC(2026, 10, 15, 9, 0, number)).toISOString();
  return server.services.inbox.put({
    id,
    kind: "triage",
    status: "open",
    priority: "normal",
    notify: "automation",
    title: `Should I take this on? #${number}`,
    body: null,
    projectId: "p1",
    sessionId: null,
    threadId: null,
    itemId: null,
    requestId: null,
    issue: { number, url: `https://github.com/o/r/issues/${number}` },
    pr: null,
    automationRunId: null,
    createdAt: at,
    updatedAt: at,
    resolvedAt: null,
    resolution: null,
    ...extra,
  });
}

describe("TriageSettler", () => {
  it("resolves only open triage items whose synced issue is closed, keeping them in history", () => {
    triage("closed", 1);
    triage("open", 2);
    triage("unknown", 3);
    triage("other-project", 1, { projectId: "p2" });
    triage("message", 1, { kind: "message" });
    const states: Record<string, "open" | "closed"> = { "p1:1": "closed", "p1:2": "open" };
    const settler = new TriageSettler({
      store: server.services.store,
      inbox: server.services.inbox,
      issue: (projectId, number) => {
        const state = states[`${projectId}:${number}`];
        return state ? { number, state } : undefined;
      },
    });

    expect(settler.sweep().map((i) => i.id)).toEqual(["closed"]);
    const closed = server.services.inbox.get("closed");
    expect(closed.status).toBe("resolved");
    expect(closed.resolution).toEqual({ by: "agent-rishi", note: "Issue #1 was closed on GitHub" });
    for (const id of ["open", "unknown", "other-project", "message"]) {
      expect(server.services.inbox.get(id).status).toBe("open");
    }
    // A second pass changes nothing.
    expect(settler.sweep()).toEqual([]);
  });
});
