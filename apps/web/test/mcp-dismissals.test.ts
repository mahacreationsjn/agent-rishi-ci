import type { McpServerState } from "@agent-rishi/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { dismissMcpProblems, undismissedMcpProblems } from "@/lib/mcp-dismissals";

const KEY = "agent-rishi.mcp-notice-dismissed";
const db: McpServerState = { name: "db", state: "failed" };
const linear: McpServerState = { name: "linear", state: "needs_sign_in" };
const session = (projectId: string | null, id = "s-1") => ({ id, projectId });

beforeEach(() => localStorage.clear());
afterEach(() => vi.restoreAllMocks());

describe("MCP notice dismissals", () => {
  it("are kept per project, by server name and state", () => {
    dismissMcpProblems(session("p-a"), [db]);
    expect(undismissedMcpProblems(session("p-a", "s-2"), [db, linear])).toEqual([linear]);
    expect(undismissedMcpProblems(session("p-b"), [db])).toEqual([db]);
    expect(undismissedMcpProblems(session(null), [db])).toEqual([db]);
    // The same server in trouble another way shows again.
    expect(
      undismissedMcpProblems(session("p-a"), [{ name: "db", state: "needs_sign_in" }]),
    ).toEqual([{ name: "db", state: "needs_sign_in" }]);
  });

  it("ignores a stored value that isn't theirs", () => {
    localStorage.setItem(KEY, "not json");
    expect(undismissedMcpProblems(session("p-a"), [db])).toEqual([db]);
    localStorage.setItem(KEY, JSON.stringify({ "project:p-a": "failed:db" }));
    expect(undismissedMcpProblems(session("p-a"), [db])).toEqual([db]);
    dismissMcpProblems(session("p-a"), [db]);
    expect(undismissedMcpProblems(session("p-a"), [db])).toEqual([]);
  });

  it("remember a bounded number of projects and servers, dropping the oldest", () => {
    for (let i = 0; i < 105; i++) dismissMcpProblems(session(`p-${i}`), [db]);
    // Dismissing again in an old project makes it the most recent.
    dismissMcpProblems(session("p-5"), [linear]);
    const servers = Array.from({ length: 60 }, (_, i) => ({
      name: `s${i}`,
      state: "failed" as const,
    }));
    dismissMcpProblems(session("p-many"), servers);

    const stored = JSON.parse(localStorage.getItem(KEY) ?? "{}") as Record<string, string[]>;
    const scopes = Object.keys(stored);
    expect(scopes).toHaveLength(100);
    expect(scopes.at(-2)).toBe("project:p-5");
    expect(scopes).not.toContain("project:p-6");
    expect(stored["project:p-many"]).toHaveLength(50);
    expect(undismissedMcpProblems(session("p-many"), servers).map((s) => s.name)).toEqual(
      servers.slice(0, 10).map((s) => s.name),
    );
  });

  // Last: it leaves the module remembering in memory until a write succeeds again.
  it("still hide what was dismissed for the page when localStorage can't be written", () => {
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new DOMException("quota", "QuotaExceededError");
    });
    expect(() => dismissMcpProblems(session("p-a"), [db])).not.toThrow();
    expect(undismissedMcpProblems(session("p-a"), [db, linear])).toEqual([linear]);

    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new DOMException("denied", "SecurityError");
    });
    expect(undismissedMcpProblems(session("p-a"), [db, linear])).toEqual([linear]);
  });
});
