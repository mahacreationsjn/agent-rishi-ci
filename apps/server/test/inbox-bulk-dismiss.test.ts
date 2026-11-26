import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DismissInboxResponse,
  INBOX_BULK_MAX,
  InboxCounts,
  type InboxItem,
  InboxItemKind,
  InboxNotify,
  inboxWaitsOnYou,
  RestoreInboxResponse,
} from "@agent-rishi/contracts";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type RunningServer, startServer } from "../src";
import { removeTree } from "./support/remove-tree";

/** The inbox's bulk dismiss and its undo (#407), over the HTTP routes and a real database. */

const TOKEN = "b".repeat(64);
let home: string;
let server: RunningServer;

beforeEach(async () => {
  home = mkdtempSync(join(tmpdir(), "agent-rishi-inbox-bulk-"));
  server = await startServer({
    port: 0,
    dataDir: join(home, "data"),
    token: TOKEN,
    runner: false,
    secrets: "memory",
    checkSetupOnStart: false,
  });
});

afterEach(async () => {
  await server.close();
  await removeTree(home);
});

const call = async (method: string, path: string, body?: unknown) => {
  const res = await fetch(`${server.url}/api${path}`, {
    method,
    headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, json: (await res.json()) as unknown };
};

const dismiss = async (body: unknown) => {
  const res = await call("POST", "/inbox/dismiss", body);
  expect(res.status).toBe(200);
  return DismissInboxResponse.parse(res.json);
};
const restore = async (ids: string[]) => {
  const res = await call("POST", "/inbox/restore", { ids });
  expect(res.status).toBe(200);
  return RestoreInboxResponse.parse(res.json);
};
const counts = async () => InboxCounts.parse((await call("GET", "/inbox/counts")).json);
const statusOf = (id: string) => server.services.inbox.get(id).status;

let n = 0;
function put(id: string, extra: Partial<InboxItem> = {}): InboxItem {
  return server.services.inbox.put(item(id, extra));
}

/** An open item for project p1, created a second after the one before. */
function item(id: string, extra: Partial<InboxItem> = {}): InboxItem {
  const at = new Date(Date.UTC(2026, 10, 15, 9, 0, n++)).toISOString();
  return {
    id,
    kind: "message",
    status: "open",
    priority: "normal",
    notify: "factory",
    title: id,
    body: null,
    projectId: "p1",
    sessionId: null,
    threadId: null,
    itemId: null,
    requestId: null,
    issue: null,
    pr: null,
    automationRunId: null,
    createdAt: at,
    updatedAt: at,
    resolvedAt: null,
    resolution: null,
    ...extra,
  };
}

/** Notices anyone may clear, and the items that wait on the user. */
function seed() {
  put("decision", { title: "Factory decided: naming" });
  put("ready", { kind: "pr_review", notify: "needs_you" });
  put("failed", { kind: "run_failed", notify: "failure" });
  put("digest", { kind: "automation_result", priority: "low" });
  put("other-project", { projectId: "p2" });
  put("question", { kind: "question", priority: "normal", notify: "needs_you" });
  put("approval", { kind: "approval", priority: "high", notify: "needs_you" });
  put("spec", { kind: "spec_approval", notify: "needs_you" });
  put("setup", { kind: "setup_change", priority: "high", notify: "needs_you" });
  put("inbox:factory-regression:item1", {
    kind: "run_failed",
    priority: "high",
    notify: "failure",
    title: "main is red and the revert can't merge",
  });
  put("needs-human", { priority: "high", notify: "needs_you", title: "Factory needs you: x" });
}
const WAITING = [
  "question",
  "approval",
  "spec",
  "setup",
  "inbox:factory-regression:item1",
  "needs-human",
];

describe("inbox bulk dismiss", () => {
  it("by filter dismisses the notices and leaves what waits on the user", async () => {
    seed();
    expect((await counts()).byProject.p1).toBe(10);

    const res = await dismiss({ filter: { projectId: "p1" }, note: "too many" });
    expect(res.ids.sort()).toEqual(["decision", "digest", "failed", "ready"]);
    expect(res.dismissed).toBe(4);
    expect(res.kept).toBe(WAITING.length);
    for (const id of WAITING) expect(statusOf(id), id).toBe("open");
    expect(statusOf("other-project")).toBe("open");
    expect(server.services.inbox.get("decision")).toMatchObject({
      status: "dismissed",
      resolution: { bulk: true, note: "too many" },
    });

    // Counts follow, as for a hand dismissal.
    const after = await counts();
    expect(after.open).toBe(7);
    expect(after.byProject.p1).toBe(WAITING.length);
    expect(after.byKind.pr_review).toBeUndefined();
  });

  it("by filter narrows to kinds, as an inbox tab does", async () => {
    seed();
    const res = await dismiss({ filter: { kinds: ["run_failed", "cleanup_failed"] } });
    // The regression is a failed run too, but it waits on the user.
    expect(res).toEqual({ dismissed: 1, ids: ["failed"], kept: 1 });
    expect(statusOf("decision")).toBe("open");
  });

  it("by kinds reaches matching items older than the newest open ones (#417)", async () => {
    put("old-failed", { kind: "run_failed", notify: "failure" });
    // More newer open items of another kind than one list of the inbox holds.
    const newer = Array.from({ length: INBOX_BULK_MAX }, (_, i) => item(`msg${i}`));
    server.services.store.append(
      newer.map((it) => ({
        type: "inbox.created" as const,
        sessionId: null,
        payload: { item: it },
      })),
    );

    const res = await dismiss({ filter: { kinds: ["run_failed"] } });
    expect(res).toEqual({ dismissed: 1, ids: ["old-failed"], kept: 0 });
    expect(statusOf("old-failed")).toBe("dismissed");
    expect(statusOf("msg0")).toBe("open");
  });

  it("by filter reaches notices older than the newest items that wait on the user (#433)", async () => {
    put("old-notice");
    // More newer open items that wait on the user than one bulk dismiss covers.
    const waiting = Array.from({ length: INBOX_BULK_MAX }, (_, i) =>
      item(`q${i}`, { kind: "question", notify: "needs_you" }),
    );
    server.services.store.append(
      waiting.map((it) => ({
        type: "inbox.created" as const,
        sessionId: null,
        payload: { item: it },
      })),
    );

    const res = await dismiss({ filter: { projectId: "p1" } });
    expect(res).toEqual({ dismissed: 1, ids: ["old-notice"], kept: INBOX_BULK_MAX });
    expect(statusOf("old-notice")).toBe("dismissed");
    expect(statusOf("q0")).toBe("open");
  });

  it("by filter keeps exactly what inboxWaitsOnYou keeps, for every kind, priority and notify", async () => {
    const all = InboxItemKind.options.flatMap((kind) =>
      (["low", "normal", "high"] as const).flatMap((priority) =>
        InboxNotify.options.map((notify) =>
          item(`${kind}-${priority}-${notify}`, { kind, priority, notify }),
        ),
      ),
    );
    server.services.store.append(
      all.map((it) => ({ type: "inbox.created" as const, sessionId: null, payload: { item: it } })),
    );

    const res = await dismiss({ filter: {} });
    const notices = all.filter((it) => !inboxWaitsOnYou(it)).map((it) => it.id);
    expect(res.ids.sort()).toEqual(notices.sort());
    expect(res.kept).toBe(all.length - notices.length);
  });

  it("by ids skips what waits on the user, ids that aren't open and repeats", async () => {
    seed();
    server.services.inbox.close(server.services.inbox.get("digest"), "resolved", null);
    const res = await dismiss({
      ids: ["decision", "decision", "digest", "missing", "question", "spec", "ready"],
    });
    expect(res).toEqual({ dismissed: 2, ids: ["decision", "ready"], kept: 2 });
    expect(statusOf("digest")).toBe("resolved");
    expect(statusOf("question")).toBe("open");
  });

  it("refuses more ids than the cap, and a request with both ids and a filter", async () => {
    put("one");
    const ids = Array.from({ length: INBOX_BULK_MAX + 1 }, (_, i) => (i === 0 ? "one" : `x${i}`));
    const tooMany = await call("POST", "/inbox/dismiss", { ids });
    expect(tooMany.status).toBe(400);
    expect(tooMany.json).toMatchObject({ error: { code: "bad_request" } });
    expect((await call("POST", "/inbox/dismiss", { ids: ["one"], filter: {} })).status).toBe(400);
    expect((await call("POST", "/inbox/dismiss", {})).status).toBe(400);
    expect(statusOf("one")).toBe("open");
    // At the cap it goes through.
    expect((await dismiss({ ids: ids.slice(0, INBOX_BULK_MAX) })).ids).toEqual(["one"]);
  });

  it("undo restores exactly the dismissed set, and the counts come back", async () => {
    seed();
    put("by-hand", { kind: "cleanup_failed" });
    const before = await counts();
    await server.services.inbox.resolve("by-hand", { status: "dismissed" });

    const res = await dismiss({ filter: { projectId: "p1" } });
    expect(res.ids.sort()).toEqual(["decision", "digest", "failed", "ready"]);
    // Meanwhile both of these are raised again: one is dismissed by hand, the other settled by
    // Agent Rishi. Neither is a bulk dismissal any more, so only the other two come back.
    put("ready", { kind: "pr_review", notify: "needs_you", title: "ready again" });
    await server.services.inbox.resolve("ready", { status: "dismissed" });
    put("failed", { kind: "run_failed", notify: "failure", attempts: 2 });
    server.services.inbox.settle(server.services.inbox.get("failed"), {
      by: "agent-rishi",
      note: "Ran again",
    });

    const undone = await restore([...res.ids, "by-hand", "question", "missing"]);
    expect(undone.ids.sort()).toEqual(["decision", "digest"]);
    expect(undone.restored).toBe(2);
    expect(server.services.inbox.get("decision")).toMatchObject({
      status: "open",
      resolution: null,
      resolvedAt: null,
    });
    expect(statusOf("ready")).toBe("dismissed");
    expect(statusOf("failed")).toBe("resolved");
    expect(statusOf("by-hand")).toBe("dismissed");
    expect(statusOf("question")).toBe("open");

    // A second undo changes nothing.
    expect(await restore(res.ids)).toEqual({ restored: 0, ids: [] });
    const after = await counts();
    expect(after.open).toBe(before.open - 3);
    expect(after.byKind.message).toBe(3);
    expect(after.byKind.automation_result).toBe(1);
    expect(after.byKind.pr_review).toBeUndefined();
  });

  it("restores the whole set when nothing changed in between", async () => {
    seed();
    const before = await counts();
    const res = await dismiss({ filter: {} });
    expect(res.dismissed).toBe(5);
    expect((await counts()).open).toBe(before.open - 5);
    expect((await restore(res.ids)).restored).toBe(5);
    expect(await counts()).toEqual(before);
  });
});
