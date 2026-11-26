import type { Session } from "@agent-rishi/contracts";
import { act, fireEvent, screen, waitFor } from "@testing-library/react";
import { type ReactElement, useState } from "react";
import { beforeEach, describe, expect, it } from "vitest";
import { McpNotice } from "@/components/thread/mcp-notice";
import { createMockClient } from "@/lib/api/mock";
import { makeSession } from "@/lib/api/mock/fixtures/helpers";
import { mcpProblems } from "@/lib/mcp-status";
import { renderWithClient } from "./utils";

// Dismissals are remembered in localStorage.
beforeEach(() => localStorage.clear());

const DISMISSED_KEY = "agent-rishi.mcp-notice-dismissed";

const render = (ui: ReactElement) => renderWithClient(ui, createMockClient(), { withRouter: true });

/** The notices' text once the provider list loaded: a notice naming `anchor` must show. */
async function noticesWith(anchor: string) {
  await screen.findAllByText(anchor);
  return screen.getAllByTestId("mcp-notice").map((n) => n.textContent ?? "");
}

const session = (mcpServers: Session["mcpServers"], over: Partial<Session> = {}) =>
  makeSession({
    id: "s-mcp",
    projectId: "p-storefront",
    role: "agent",
    status: "idle",
    provider: "claude",
    purpose: "Test",
    workKey: "test:mcp",
    mcpServers,
    ...over,
  });

const troubled: Session["mcpServers"] = [
  { name: "agent-rishi", state: "connected" },
  { name: "linear", state: "needs_sign_in" },
  { name: "db", state: "failed", error: "spawn db-mcp ENOENT" },
  { name: "slow", state: "starting" },
];

/** Reports a new server list to the mounted `Live`, as a `session.updated` would. */
let report: (next: Session["mcpServers"]) => void = () => {};

/** The notice for a session whose servers change while it is shown. */
function Live() {
  const [servers, setServers] = useState(troubled);
  report = setServers;
  return <McpNotice session={session(servers)} />;
}

describe("MCP server notice", () => {
  it("lists only failed and needs-sign-in servers of a live session with the capability", () => {
    expect(mcpProblems(session(troubled), true).map((s) => s.name)).toEqual(["linear", "db"]);
    expect(mcpProblems(session(troubled), false)).toEqual([]);
    expect(mcpProblems(session(troubled, { status: "completed" }), true)).toEqual([]);
    expect(
      mcpProblems(session(troubled, { archivedAt: "2026-11-16T10:00:00.000Z" }), true),
    ).toEqual([]);
    expect(mcpProblems(session(null), true)).toEqual([]);
  });

  it("names the servers and how to fix them, and goes away once they connect", async () => {
    renderWithClient(<Live />, createMockClient(), { withRouter: true });
    const notice = await screen.findByTestId("mcp-notice");
    expect(notice.textContent).toContain("2 MCP servers aren't available to the agent");
    expect(notice.textContent).toContain("linear (needs sign-in)");
    expect(notice.textContent).toContain("db (failed)");
    expect(notice.textContent).toContain("Claude Code's own login");
    expect(screen.getByTitle("spawn db-mcp ENOENT")).toBeTruthy();
    const link = screen.getByRole("link", { name: "Agents › MCP servers" });
    expect(link.getAttribute("href")).toContain("tab=mcp");

    const connected = troubled?.map((s) => ({ name: s.name, state: "connected" as const }));
    act(() => report(connected));
    await waitFor(() => expect(screen.queryByTestId("mcp-notice")).toBeNull());
  });

  it("can be dismissed", async () => {
    render(<McpNotice session={session(troubled)} />);
    await screen.findByTestId("mcp-notice");
    fireEvent.click(screen.getByRole("button", { name: "Dismiss" }));
    expect(screen.queryByTestId("mcp-notice")).toBeNull();
  });

  // #528: Claude reports every claude.ai connector and plugin server the user never signed into
  // as needing sign-in, on every session; they are not this work's servers.
  it("leaves account connectors and plugins that only need sign-in out", async () => {
    const servers: Session["mcpServers"] = [
      { name: "agent-rishi", state: "connected", origin: "config" },
      { name: "claude.ai Gmail", state: "needs_sign_in", origin: "account" },
      { name: "plugin:data:hex", state: "needs_sign_in", origin: "plugin" },
      { name: "plugin:data:definite", state: "failed", origin: "plugin" },
      { name: "linear", state: "needs_sign_in", origin: "config" },
    ];
    expect(mcpProblems(session(servers), true).map((s) => s.name)).toEqual([
      "plugin:data:definite",
      "linear",
    ]);

    // Only account and plugin servers waiting for sign-in: no notice at all.
    const nagsOnly = servers.filter((s) => s.origin !== "config" && s.state !== "failed");
    render(
      <>
        <McpNotice session={session(nagsOnly)} />
        <McpNotice session={session(troubled, { id: "s-anchor", projectId: "p-other" })} />
      </>,
    );
    const notices = await noticesWith("db");
    expect(notices).toHaveLength(1);
    expect(notices[0]).not.toContain("claude.ai Gmail");
  });

  // #528: Dismiss was component state, so the notice came back on every remount.
  it("stays dismissed for the project when the thread remounts", async () => {
    const first = render(<McpNotice session={session(troubled)} />);
    await screen.findByTestId("mcp-notice");
    fireEvent.click(screen.getByRole("button", { name: "Dismiss" }));
    first.unmount();

    // Another session of the same project, and one of another project for contrast.
    render(
      <>
        <McpNotice session={session(troubled, { id: "s-again" })} />
        <McpNotice session={session(troubled, { id: "s-elsewhere", projectId: "p-other" })} />
      </>,
    );
    const notices = await screen.findAllByTestId("mcp-notice");
    expect(notices).toHaveLength(1);
    expect(notices[0]?.querySelector("a")?.getAttribute("href")).toContain("project=p-other");
    expect(localStorage.getItem(DISMISSED_KEY)).toContain("project:p-storefront");
  });

  it("comes back for a server newly in trouble, naming only that one", async () => {
    render(<Live />);
    await screen.findByTestId("mcp-notice");
    fireEvent.click(screen.getByRole("button", { name: "Dismiss" }));
    expect(screen.queryByTestId("mcp-notice")).toBeNull();

    act(() => report([...(troubled ?? []), { name: "api", state: "failed", error: "HTTP 500" }]));
    const notice = await screen.findByTestId("mcp-notice");
    expect(notice.textContent).toContain("An MCP server isn't available");
    expect(notice.textContent).toContain("api (failed)");
    expect(notice.textContent).not.toContain("linear");
    expect(notice.textContent).not.toContain("db (failed)");
  });

  it("keeps Agent Rishi's own server in every session until dismissed there", async () => {
    const ownTrouble: Session["mcpServers"] = [
      { name: "agent-rishi", state: "failed", error: "MCP error -32000: Connection closed" },
      { name: "db", state: "failed" },
    ];
    const first = render(<McpNotice session={session(ownTrouble, { id: "s-1" })} />);
    await screen.findByTestId("mcp-notice");
    fireEvent.click(screen.getByRole("button", { name: "Dismiss" }));
    first.unmount();

    render(
      <>
        <McpNotice session={session(ownTrouble, { id: "s-1" })} />
        <McpNotice session={session(ownTrouble, { id: "s-2" })} />
      </>,
    );
    // s-1 stays quiet; s-2 of the same project names only agent-rishi (db was dismissed for it).
    const notices = await noticesWith("agent-rishi");
    expect(notices).toHaveLength(1);
    expect(notices[0]).toContain("agent-rishi (failed)");
    expect(notices[0]).toContain("can't ask you questions");
    expect(notices[0]).not.toContain("db (failed)");
  });
});
