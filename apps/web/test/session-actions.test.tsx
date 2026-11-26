import type { ArchiveSessionResponse, Session } from "@agent-rishi/contracts";
import { fireEvent, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { ArchivedSessionsList, SessionsList } from "@/components/project/lists";
import type { RowMenuAction, RowMenuEntry } from "@/components/shell/sidebar/row-menu";
import { sessionMenuEntries } from "@/components/shell/sidebar/session-menu";
import { forkableTurn } from "@/components/thread/fork-from-here";
import { createMockClient } from "@/lib/api/mock";
import { sessions as fixtureSessions } from "@/lib/api/mock/fixtures/sessions";
import { compactBlocked, compactSupported } from "@/lib/compact-session";
import {
  announceArchive,
  canPushFirst,
  canStop,
  forkBlocked,
  forkSupported,
  NOT_A_REPO_ACTION_REASON,
  type SessionActions,
  sessionLink,
  useForkSession,
  useSessionActions,
} from "@/lib/session-actions";
import { activeSessions, sessionCounts } from "@/lib/session-filter";
import { renderWithClient } from "./utils";

const toast = vi.hoisted(() =>
  Object.assign(vi.fn(), {
    success: vi.fn(),
    error: vi.fn(),
    warning: vi.fn(),
    loading: vi.fn(() => "loading-1"),
  }),
);
vi.mock("sonner", () => ({ toast }));

const session = (id: string) => {
  const found = fixtureSessions.find((s) => s.id === id);
  if (!found) throw new Error(`no fixture session ${id}`);
  return found;
};

/** Renders the hook and reports its actions. */
function Probe({ target, onActions }: { target: Session; onActions: (a: SessionActions) => void }) {
  onActions(useSessionActions(target));
  return <span>ready</span>;
}

/** Renders `useForkSession` and reports its `fork`. */
function ForkProbe({
  target,
  onFork,
}: {
  target: Session;
  onFork: (fork: (turnId?: string) => void) => void;
}) {
  onFork(useForkSession(target).fork);
  return <span>ready</span>;
}

/** Render `useSessionActions` for a session and hand back the latest actions. */
async function actionsFor(target: Session, client = createMockClient()) {
  let latest: SessionActions | undefined;
  renderWithClient(
    <Probe
      target={target}
      onActions={(a) => {
        latest = a;
      }}
    />,
    client,
    { withRouter: true },
  );
  await screen.findByText("ready");
  if (!latest) throw new Error("not rendered");
  return { actions: latest, client };
}

const labels = (entries: RowMenuEntry[]) => entries.map((e) => (e === "separator" ? "—" : e.label));
const action = (entries: RowMenuEntry[], label: string) =>
  entries.find((e): e is RowMenuAction => e !== "separator" && e.label === label);

describe("useSessionActions", () => {
  it("archives with an Undo that unarchives", async () => {
    toast.success.mockClear();
    const { actions, client } = await actionsFor(session("s-search"));
    const archive = vi.spyOn(client, "archiveSession");
    const unarchive = vi.spyOn(client, "unarchiveSession");
    actions.archive();
    await waitFor(() => expect(toast.success).toHaveBeenCalled());
    expect(archive).toHaveBeenCalledWith("s-search", { force: false });
    const [message, options] = toast.success.mock.calls[0] ?? [];
    expect(message).toBe("Session archived and its worktree removed");
    expect(options.action.label).toBe("Undo");
    options.action.onClick();
    await waitFor(() => expect(unarchive).toHaveBeenCalledWith("s-search"));
  });

  it("says when uncommitted changes were discarded", async () => {
    toast.success.mockClear();
    const client = createMockClient();
    vi.spyOn(client, "archiveSession").mockResolvedValueOnce({
      session: { ...session("s-deps"), archivedAt: new Date().toISOString() },
      worktree: { status: "removed", message: "Its uncommitted changes were discarded" },
    });
    const { actions } = await actionsFor(session("s-deps"), client);
    actions.archive();
    await waitFor(() => expect(toast.success).toHaveBeenCalled());
    const [message, options] = toast.success.mock.calls[0] ?? [];
    expect(message).toBe("Session archived and its worktree removed");
    expect(options.description).toBe("Its uncommitted changes were discarded");
  });

  it("offers Try again and Undo when the worktree couldn't be removed", async () => {
    toast.warning.mockClear();
    const client = createMockClient();
    const detail = `A file in the worktree is in use (${"node_modules/".repeat(20)}x.node).`;
    const failed: ArchiveSessionResponse = {
      session: { ...session("s-deps"), archivedAt: new Date().toISOString() },
      worktree: { status: "failed", message: detail },
    };
    const archive = vi
      .spyOn(client, "archiveSession")
      .mockResolvedValueOnce(failed)
      .mockResolvedValueOnce({ ...failed, worktree: { status: "removed", message: null } });
    const unarchive = vi.spyOn(client, "unarchiveSession");
    const { actions } = await actionsFor(session("s-deps"), client);
    actions.archive();
    await waitFor(() => expect(toast.warning).toHaveBeenCalled());
    const [message, options] = toast.warning.mock.calls[0] ?? [];
    expect(message).toBe("Session archived, but its worktree couldn't be removed yet");
    expect(options.description.length).toBeLessThanOrEqual(160);
    expect(options.description).toMatch(/^A file in the worktree is in use/);
    expect(options.action.label).toBe("Try again");
    expect(options.cancel.label).toBe("Undo");
    options.action.onClick();
    await waitFor(() => expect(archive).toHaveBeenCalledTimes(2));
    expect(archive).toHaveBeenLastCalledWith("s-deps", { force: false });
    options.cancel.onClick();
    await waitFor(() => expect(unarchive).toHaveBeenCalledWith("s-deps"));
  });

  it("offers Remove anyway and Undo when the worktree had changes", async () => {
    toast.mockClear();
    const client = createMockClient();
    const kept: ArchiveSessionResponse = {
      session: { ...session("s-deps"), archivedAt: new Date().toISOString() },
      worktree: { status: "kept_changes", message: null },
    };
    const archive = vi
      .spyOn(client, "archiveSession")
      .mockResolvedValueOnce(kept)
      .mockResolvedValueOnce({ ...kept, worktree: { status: "removed", message: null } });
    const unarchive = vi.spyOn(client, "unarchiveSession");
    const { actions } = await actionsFor(session("s-deps"), client);
    actions.archive();
    await waitFor(() => expect(toast).toHaveBeenCalled());
    const [, options] = toast.mock.calls[0] ?? [];
    expect(options.action.label).toBe("Remove anyway");
    expect(options.cancel.label).toBe("Undo");
    options.action.onClick();
    await waitFor(() => expect(archive).toHaveBeenLastCalledWith("s-deps", { force: true }));
    options.cancel.onClick();
    await waitFor(() => expect(unarchive).toHaveBeenCalledWith("s-deps"));
  });

  it("offers Push the branch first and Delete anyway for a container kept for unpushed commits", async () => {
    toast.warning.mockClear();
    const client = createMockClient();
    const unpushed = {
      current: "agent-rishi/fix",
      uncommitted: 0,
      branches: [{ name: "agent-rishi/fix", commits: 2 }],
      stashes: 0,
    };
    const kept: ArchiveSessionResponse = {
      session: { ...session("s-deps"), archivedAt: new Date().toISOString() },
      worktree: { status: "kept_changes", message: "kept", unpushed },
    };
    const removed = { ...kept, worktree: { status: "removed" as const, message: null } };
    const archive = vi
      .spyOn(client, "archiveSession")
      .mockResolvedValueOnce(kept)
      .mockResolvedValue(removed);
    const push = vi
      .spyOn(client, "gitPush")
      .mockResolvedValue({ remote: "origin", branch: "agent-rishi/fix" });
    const { actions } = await actionsFor(session("s-deps"), client);
    actions.archive();
    await waitFor(() => expect(toast.warning).toHaveBeenCalled());
    const [title, options] = toast.warning.mock.calls[0] ?? [];
    expect(title).toMatch(/container was kept/);
    expect(options.description).toBe(
      "2 unpushed commits on agent-rishi/fix. Delete anyway deletes this work for good.",
    );
    expect(options.action.label).toBe("Push the branch first");
    expect(options.cancel.label).toBe("Delete anyway");
    options.action.onClick();
    await waitFor(() => expect(push).toHaveBeenCalledWith("s-deps", {}));
    await waitFor(() => expect(archive).toHaveBeenCalledTimes(2));
    expect(archive).toHaveBeenLastCalledWith("s-deps", { force: false });
    options.cancel.onClick();
    await waitFor(() => expect(archive).toHaveBeenLastCalledWith("s-deps", { force: true }));
  });

  it("offers Delete anyway and Undo when pushing the branch wouldn't save the work", () => {
    toast.warning.mockClear();
    const actions = { undo: vi.fn(), retry: vi.fn(), force: vi.fn(), push: vi.fn() };
    announceArchive(
      {
        session: { ...session("s-deps"), archivedAt: new Date().toISOString() },
        worktree: {
          status: "kept_changes",
          message: "kept",
          unpushed: { current: "agent-rishi/fix", uncommitted: 0, branches: [], stashes: 1 },
        },
      },
      actions,
    );
    const [, options] = toast.warning.mock.calls[0] ?? [];
    expect(options.description).toBe("1 stash. Delete anyway deletes this work for good.");
    expect(options.action.label).toBe("Delete anyway");
    expect(options.cancel.label).toBe("Undo");
    expect(canPushFirst({ current: null, uncommitted: 0, branches: [], stashes: 0 })).toBe(false);
  });

  it("renames with a trimmed title and ignores blank or unchanged ones", async () => {
    const client = createMockClient();
    const update = vi.spyOn(client, "updateSession");
    const target = session("s-search");
    const { actions } = await actionsFor(target, client);
    actions.rename("   ");
    actions.rename(target.title ?? target.purpose);
    expect(update).not.toHaveBeenCalled();
    actions.rename("  Search v2  ");
    await waitFor(() => expect(update).toHaveBeenCalledWith("s-search", { title: "Search v2" }));
  });

  it("offers Fork only where the provider can fork, and only once nothing is running", () => {
    const idle: Session = {
      ...session("s-search"),
      role: "agent",
      status: "idle",
      resumeToken: "claude-1",
      branch: "agent-rishi/search",
    };
    const caps = (fork: boolean) =>
      ({ id: "claude", displayName: "Claude Code", models: [], capabilities: { fork } }) as never;
    expect(forkSupported(idle, caps(true))).toBe(true);
    expect(forkSupported(idle, caps(false))).toBe(false);
    expect(forkSupported(idle, undefined)).toBe(false);
    expect(forkSupported({ ...idle, role: "pm" }, caps(true))).toBe(false);

    expect(forkBlocked(idle)).toBeNull();
    expect(forkBlocked({ ...idle, status: "stopped" })).toBeNull();
    expect(forkBlocked({ ...idle, status: "running" })).toMatch(/running turn/);
    // Waiting on the user (an approval, a question or a plan to approve).
    expect(forkBlocked({ ...idle, status: "waiting" })).toMatch(/waiting on/);
    expect(forkBlocked({ ...idle, status: "starting" })).toMatch(/hasn't started/);
    expect(forkBlocked({ ...idle, resumeToken: null })).toMatch(/No conversation/);
    expect(forkBlocked({ ...idle, branch: null })).toMatch(/git branch/);
  });

  it("never forks in a project whose folder isn't a git repository, and says so first (#424)", () => {
    const idle: Session = {
      ...session("s-search"),
      role: "agent",
      status: "idle",
      resumeToken: "claude-1",
      branch: "agent-rishi/search",
    };
    const notGit = { isGitRepo: false };
    expect(forkBlocked(idle, notGit)).toBe(NOT_A_REPO_ACTION_REASON);
    // A folder that isn't a repository won't change when the turn ends: that reason comes first.
    expect(forkBlocked({ ...idle, status: "running" }, notGit)).toBe(NOT_A_REPO_ACTION_REASON);
    expect(forkBlocked({ ...idle, status: "waiting" }, notGit)).toBe(NOT_A_REPO_ACTION_REASON);
    expect(forkBlocked({ ...idle, branch: null }, notGit)).toBe(NOT_A_REPO_ACTION_REASON);
    // A git project, or one not loaded yet, is as before.
    expect(forkBlocked(idle, { isGitRepo: true })).toBeNull();
    expect(forkBlocked({ ...idle, status: "running" }, undefined)).toMatch(/running turn/);
  });

  it("lists Fork, Hand off and Review disabled with the reason in a non-git project (#424)", async () => {
    const base = createMockClient();
    const client = {
      ...base,
      getSnapshot: async () => {
        const snapshot = await base.getSnapshot();
        const projects = snapshot.projects.map((p) => ({ ...p, isGitRepo: false }));
        return { ...snapshot, projects };
      },
    };
    // A finished agent session that has a branch: in a git project all three could run.
    const target: Session = { ...session("s-search"), status: "idle", resumeToken: "codex-1" };
    let latest: SessionActions | undefined;
    renderWithClient(
      <Probe
        target={target}
        onActions={(a) => {
          latest = a;
        }}
      />,
      client,
      { withRouter: true },
    );
    await waitFor(() => expect(latest?.handoffBlocked).toBe(NOT_A_REPO_ACTION_REASON));
    expect(latest?.canFork).toBe(true);
    expect(latest?.forkBlocked).toBe(NOT_A_REPO_ACTION_REASON);
    expect(latest?.canHandoff).toBe(true);
    expect(latest?.canReview).toBe(true);
    expect(latest?.reviewBlocked).toBe(NOT_A_REPO_ACTION_REASON);
  });

  it("offers Compact now only where the provider can compact, and only between turns", () => {
    const idle: Session = { ...session("s-search"), status: "idle", resumeToken: "claude-1" };
    const caps = (compact?: boolean) => ({ capabilities: { compact } }) as never;
    expect(compactSupported(idle, caps(true))).toBe(true);
    expect(compactSupported(idle, caps(false))).toBe(false);
    expect(compactSupported(idle, caps())).toBe(false);
    expect(compactSupported(idle, undefined)).toBe(false);
    expect(compactSupported({ ...idle, archivedAt: "2026-11-15T10:00:00Z" }, caps(true))).toBe(
      false,
    );

    expect(compactBlocked(idle)).toBeNull();
    expect(compactBlocked({ ...idle, status: "stopped" })).toBeNull();
    expect(compactBlocked({ ...idle, status: "running" })).toMatch(/running turn/);
    expect(compactBlocked({ ...idle, status: "waiting" })).toMatch(/waiting on/);
    expect(compactBlocked({ ...idle, status: "queued" })).toMatch(/hasn't started/);
    expect(compactBlocked({ ...idle, resumeToken: null })).toMatch(/No conversation/);
    // The project's checks running after the last turn (#412).
    expect(compactBlocked(idle, true)).toMatch(/checks to finish/);
  });

  it("forks through the client and opens the new session", async () => {
    toast.success.mockClear();
    const client = createMockClient();
    const fork = vi.spyOn(client, "forkSession");
    const { actions } = await actionsFor(session("s-search"), client);
    actions.fork();
    await waitFor(() => expect(fork).toHaveBeenCalledWith("s-search"));
    expect(toast.loading).toHaveBeenCalledWith("Forking the session…");
    // The "Forking…" toast turns into the result.
    await waitFor(() =>
      expect(toast.success).toHaveBeenCalledWith(
        "Forked into a new session",
        expect.objectContaining({ id: "loading-1" }),
      ),
    );
  });

  it("forks from a turn, saying the copy ends with it", async () => {
    toast.success.mockClear();
    const client = createMockClient();
    const fork = vi.spyOn(client, "forkSession");
    let fromTurn: ((turnId?: string) => void) | undefined;
    renderWithClient(
      <ForkProbe
        target={session("s-search")}
        onFork={(f) => {
          fromTurn = f;
        }}
      />,
      client,
      { withRouter: true },
    );
    await screen.findByText("ready");
    fromTurn?.("turn-2");
    await waitFor(() => expect(fork).toHaveBeenCalledWith("s-search", { turnId: "turn-2" }));
    await waitFor(() =>
      expect(toast.success).toHaveBeenCalledWith(
        "Forked into a new session",
        expect.objectContaining({ description: expect.stringMatching(/after that turn/) }),
      ),
    );
  });

  it("offers Fork from here on root turns that are the latest or recorded a fork point", () => {
    const s = { ...session("s-search"), rootThreadId: "t-root" };
    const row = (patch: { threadId?: string; forkPoint?: string | null; latest?: boolean }) =>
      ({
        key: "end:u1",
        type: "turn-end",
        filesChanged: 0,
        durationMs: null,
        latest: patch.latest ?? false,
        turn: {
          id: "u1",
          threadId: patch.threadId ?? "t-root",
          status: "completed",
          startedAt: "2026-11-12T10:00:00.000Z",
          completedAt: "2026-11-12T10:01:00.000Z",
          error: null,
          forkPoint: patch.forkPoint ?? null,
        },
      }) as const;
    expect(forkableTurn(s, row({ forkPoint: "fp-1" }))).toBe(true);
    expect(forkableTurn(s, row({ latest: true }))).toBe(true);
    // An earlier turn without a fork point, and a subagent's turn, can't be forked from.
    expect(forkableTurn(s, row({}))).toBe(false);
    expect(forkableTurn(s, row({ threadId: "t-child", forkPoint: "fp-1" }))).toBe(false);
  });

  it("stops only sessions that are working or waiting", () => {
    expect(canStop({ status: "running" })).toBe(true);
    expect(canStop({ status: "waiting" })).toBe(true);
    expect(canStop({ status: "idle" })).toBe(false);
    expect(canStop({ status: "failed" })).toBe(false);
    expect(sessionLink("s 1", "http://127.0.0.1:4318")).toBe(
      "http://127.0.0.1:4318/sessions/s%201",
    );
  });
});

describe("session row menu", () => {
  const fake = (patch: Partial<SessionActions>): SessionActions => ({
    open: vi.fn(),
    rename: vi.fn(),
    copyLink: vi.fn(async () => {}),
    copyMarkdown: vi.fn(),
    downloadMarkdown: vi.fn(),
    canMakeAutomation: true,
    makeAutomation: vi.fn(),
    canStop: false,
    stop: vi.fn(),
    archived: false,
    archive: vi.fn(),
    unarchive: vi.fn(),
    canFork: false,
    forkBlocked: null,
    fork: vi.fn(),
    canHandoff: false,
    handoffBlocked: null,
    handoff: vi.fn(),
    canReview: false,
    reviewBlocked: null,
    review: vi.fn(),
    ...patch,
  });

  it("lists Open, Rename, Copy link, the Markdown exports, Stop while working, then Archive", () => {
    expect(labels(sessionMenuEntries(fake({ canStop: true }), vi.fn()))).toEqual([
      "Open",
      "Rename",
      "Copy link",
      "Copy as Markdown",
      "Download as Markdown",
      "Stop",
      "—",
      "Archive",
    ]);
    expect(labels(sessionMenuEntries(fake({}), vi.fn()))).toEqual([
      "Open",
      "Rename",
      "Copy link",
      "Copy as Markdown",
      "Download as Markdown",
      "—",
      "Archive",
    ]);
  });

  it("copies and downloads the transcript as Markdown, saying secrets are redacted", () => {
    const actions = fake({});
    const entries = sessionMenuEntries(actions, vi.fn());
    action(entries, "Copy as Markdown")?.onSelect();
    expect(actions.copyMarkdown).toHaveBeenCalled();
    action(entries, "Download as Markdown")?.onSelect();
    expect(actions.downloadMarkdown).toHaveBeenCalled();
    expect(action(entries, "Copy as Markdown")?.hint).toBe("Secrets redacted");
    expect(action(entries, "Download as Markdown")?.hint).toBe("Secrets redacted");
  });

  it("offers Unarchive for archived sessions and keeps focus for Rename", () => {
    const actions = fake({ archived: true });
    const rename = vi.fn();
    const entries = sessionMenuEntries(actions, rename);
    action(entries, "Unarchive")?.onSelect();
    expect(actions.unarchive).toHaveBeenCalled();
    expect(action(entries, "Archive")).toBeUndefined();
    expect(action(entries, "Rename")?.keepFocus).toBe(true);
    action(entries, "Rename")?.onSelect();
    expect(rename).toHaveBeenCalled();
  });
});

describe("archived sessions", () => {
  const archivedAt = "2026-11-08T08:00:00.000Z";
  const list = fixtureSessions.map((s) =>
    s.id === "s-deps" || s.id === "s-a11y" ? { ...s, archivedAt } : s,
  );

  const archived = list.filter((s) => s.archivedAt);

  it("lists a project's active agent sessions and takes the archived count from the server", () => {
    const active = activeSessions(list, "p-storefront");
    expect(active.every((s) => !s.archivedAt && s.role === "agent")).toBe(true);
    expect(active.some((s) => s.id === "s-deps")).toBe(false);
    // The snapshot carries only the recent archived sessions (#323): the count is the server's.
    const counts = { "p-storefront": 40 };
    expect(
      sessionCounts({ sessions: list, archivedSessionCounts: counts }, "p-storefront"),
    ).toEqual({ active: active.length, archived: 40 });
    // Most recently updated first.
    const times = active.map((s) => Date.parse(s.updatedAt));
    expect(times).toEqual([...times].sort((a, b) => b - a));
  });

  it("pages the archived list from the server (#323)", async () => {
    const client = createMockClient();
    const [first, second] = archived;
    if (!first || !second) throw new Error("two archived fixture sessions expected");
    const listArchived = vi
      .spyOn(client, "listArchivedSessions")
      .mockImplementation(async (_projectId, query) =>
        query?.cursor === "c1"
          ? { sessions: [second], nextCursor: null }
          : { sessions: [first], nextCursor: "c1" },
      );
    renderWithClient(<ArchivedSessionsList projectId="p-storefront" />, client, {
      withRouter: true,
    });
    expect(await screen.findAllByRole("button", { name: /^Unarchive / })).toHaveLength(1);
    expect(listArchived).toHaveBeenCalledWith("p-storefront", {});

    fireEvent.click(screen.getByRole("button", { name: "Load more" }));
    await waitFor(() =>
      expect(screen.getAllByRole("button", { name: /^Unarchive / })).toHaveLength(2),
    );
    expect(listArchived).toHaveBeenLastCalledWith("p-storefront", { cursor: "c1" });
    expect(screen.queryByRole("button", { name: "Load more" })).toBeNull();
  });

  it("unarchives from the project's archived list", async () => {
    const client = createMockClient();
    const unarchive = vi.spyOn(client, "unarchiveSession");
    renderWithClient(<SessionsList sessions={archived} />, client, { withRouter: true });
    const buttons = await screen.findAllByRole("button", { name: /^Unarchive / });
    expect(buttons).toHaveLength(2);
    fireEvent.click(screen.getByRole("button", { name: /^Unarchive Dependency updates/ }));
    await waitFor(() => expect(unarchive).toHaveBeenCalledWith("s-deps"));
  });
});
