import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { InboxItem } from "@agent-rishi/contracts";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type RunningServer, startServer } from "../src";
import { removeTree } from "./support/remove-tree";

/** A PM lists its project's inbox and clears stale triage decisions and messages (#673). */

let home: string;
let server: RunningServer;

beforeEach(async () => {
  home = mkdtempSync(join(tmpdir(), "agent-rishi-pm-inbox-"));
  server = await startServer({
    port: 0,
    dataDir: join(home, "data"),
    token: "d".repeat(64),
    runner: false,
    secrets: "memory",
    checkSetupOnStart: false,
  });
});

afterEach(async () => {
  await server.close();
  await removeTree(home);
});

const call = (name: string, args: unknown, projectId = "p1") =>
  server.services.tools.call(name, args, {
    role: "pm",
    sessionId: "pm-1",
    projectId,
    caller: "mcp",
    signal: new AbortController().signal,
  });

let n = 0;
function put(id: string, extra: Partial<InboxItem> = {}): InboxItem {
  const at = new Date(Date.UTC(2026, 10, 15, 9, 0, n++)).toISOString();
  return server.services.inbox.put({
    id,
    kind: "triage",
    status: "open",
    priority: "normal",
    notify: "automation",
    title: id,
    body: null,
    projectId: "p1",
    sessionId: null,
    threadId: null,
    itemId: null,
    requestId: null,
    issue: { number: 605, url: "https://github.com/o/r/issues/605" },
    pr: null,
    automationRunId: null,
    createdAt: at,
    updatedAt: at,
    resolvedAt: null,
    resolution: null,
    ...extra,
  });
}

describe("PM inbox tools", () => {
  it("lists the project's open items and marks the ones the PM may resolve", async () => {
    put("stale-triage");
    put("approval", { kind: "approval", notify: "needs_you", issue: null });
    put("elsewhere", { projectId: "p2" });
    const res = await call("list_project_inbox", {});
    expect(res.isError).toBeFalsy();
    expect(res.text).toContain("2 open inbox item(s)");
    expect(res.text).toMatch(/stale-triage · triage · .*issue #605.*you may resolve/);
    expect(res.text).toMatch(/approval · approval · (?!.*you may resolve)/);
    expect(res.text).not.toContain("elsewhere");
  });

  it("dismisses a stale triage decision with the PM's reason", async () => {
    put("stale-triage");
    const res = await call("resolve_inbox_item", {
      inboxItemId: "stale-triage",
      reason: "Issue #605 is closed as completed",
    });
    expect(res.isError).toBeFalsy();
    const item = server.services.inbox.get("stale-triage");
    expect(item.status).toBe("dismissed");
    expect(item.resolution).toEqual({
      by: "pm",
      reason: "Issue #605 is closed as completed",
      sessionId: "pm-1",
    });
  });

  it("lets the user restore what the PM dismissed, and nothing dismissed by hand", async () => {
    put("stale-triage");
    put("by-hand");
    await call("resolve_inbox_item", { inboxItemId: "stale-triage", reason: "Issue closed" });
    await server.services.inbox.resolve("by-hand", { status: "dismissed" });
    const res = server.services.inbox.restoreMany(["stale-triage", "by-hand"]);
    expect(res.ids).toEqual(["stale-triage"]);
    const item = server.services.inbox.get("stale-triage");
    expect(item.status).toBe("open");
    expect(item.resolution).toBeNull();
    expect(server.services.inbox.get("by-hand").status).toBe("dismissed");
  });

  it("refuses approvals, questions, forms, other projects' and closed items", async () => {
    put("approval", { kind: "approval", notify: "needs_you" });
    put("question", { kind: "question", notify: "needs_you" });
    put("conflict", { kind: "conflict", notify: "needs_you" });
    put("needs-you", { kind: "message", priority: "high", notify: "needs_you" });
    put("elsewhere", { projectId: "p2" });
    put("done", { status: "resolved" });
    for (const id of ["approval", "question", "conflict", "needs-you", "elsewhere", "done"]) {
      const res = await call("resolve_inbox_item", { inboxItemId: id, reason: "stale" });
      expect(res.isError, id).toBe(true);
      expect(server.services.inbox.get(id).status, id).toBe(id === "done" ? "resolved" : "open");
    }
    const missing = await call("resolve_inbox_item", { inboxItemId: "nope", reason: "stale" });
    expect(missing.isError).toBe(true);
  });
});
