import type { Session } from "@agent-rishi/contracts";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  RouterProvider,
} from "@tanstack/react-router";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AppShell } from "@/components/shell/app-shell";
import { ThreadHeader } from "@/components/thread/thread-header";
import { TooltipProvider } from "@/components/ui/tooltip";
import { type AgentRishiClient, ApiRequestError, ClientProvider } from "@/lib/api";
import { createMockClient } from "@/lib/api/mock";
import { makeSession } from "@/lib/api/mock/fixtures/helpers";
import { useSession } from "@/lib/queries";
import { useLayoutStore } from "@/stores/layout";

/**
 * A hand-started session in a project folder that isn't a git repository (#409): it runs in
 * place, so it has no worktree, branch or base branch. The provider has opened it there, so it
 * has its root thread.
 */
const IN_PLACE = makeSession({
  id: "s-music",
  projectId: "p-storefront",
  role: "agent",
  status: "running",
  provider: "claude",
  model: "opus",
  purpose: "Research music video ideas",
  workKey: "research",
  cwd: "C:\\sandbox\\music-videos",
  worktreePath: null,
  branch: null,
  baseBranch: null,
  rootThreadId: "t-music",
});

/** The mock client with `session` added to its snapshot and some answers replaced. */
function clientWith(session: Session, answers: Partial<AgentRishiClient>): AgentRishiClient {
  const base = createMockClient();
  return {
    ...base,
    getSnapshot: async () => {
      const snapshot = await base.getSnapshot();
      return { ...snapshot, sessions: [...snapshot.sessions, session] };
    },
    ...answers,
  };
}

/**
 * The client answering for the in-place session's folder as the server does for one without
 * git: git requests fail with `not_a_repo`, no checkpoints are ever written, and the files are
 * listed from the folder itself.
 */
function inPlaceClient(): AgentRishiClient {
  return clientWith(IN_PLACE, {
    gitStatus: async () => {
      throw new ApiRequestError(409, "not_a_repo", `${IN_PLACE.cwd} is not a git repository`);
    },
    getDiff: async () => {
      throw new ApiRequestError(409, "no_checkpoints", "This session has no checkpoints yet");
    },
    listFiles: async () => ({
      root: IN_PLACE.cwd,
      entries: [{ path: "lyrics.md", kind: "file", sizeBytes: 12 }],
      truncated: false,
    }),
  });
}

/**
 * A new worktree session before `workspace.prepare` returned: no worktree yet, its `cwd` still
 * the project checkout, and not opened by the provider. The server would answer for that
 * checkout: the user's own branch and work in progress.
 */
function preparingClient(status: Session["status"]) {
  const session = makeSession({
    id: "s-new",
    projectId: "p-storefront",
    role: "agent",
    status,
    provider: "claude",
    purpose: "Add a wishlist",
    workKey: "wishlist",
    cwd: "C:\\Code\\storefront",
    worktreePath: null,
    branch: null,
    baseBranch: null,
    rootThreadId: null,
  });
  const gitStatus = vi.fn<AgentRishiClient["gitStatus"]>(async () => ({
    branch: "main",
    baseBranch: null,
    ahead: 0,
    behind: 0,
    files: [{ path: "my-wip.ts", status: " M" }],
  }));
  return { session, gitStatus, client: clientWith(session, { gitStatus }) };
}

function SessionHeader({ sessionId }: { sessionId: string }) {
  const session = useSession(sessionId);
  return session ? <ThreadHeader session={session} running={false} /> : null;
}

/** The app shell at `/sessions/<id>`, with the session's header in the centre. */
async function renderShell(sessionId: string, client: AgentRishiClient) {
  const root = createRootRoute({ component: AppShell });
  const session = createRoute({
    getParentRoute: () => root,
    path: "/sessions/$sessionId",
    component: function Session() {
      const { sessionId } = session.useParams();
      return <SessionHeader sessionId={sessionId} />;
    },
  });
  const router = createRouter({
    routeTree: root.addChildren([session]),
    history: createMemoryHistory({ initialEntries: [`/sessions/${sessionId}`] }),
  });
  render(
    <ClientProvider client={client}>
      <QueryClientProvider
        client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
      >
        <TooltipProvider>
          <RouterProvider router={router} />
        </TooltipProvider>
      </QueryClientProvider>
    </ClientProvider>,
  );
  await screen.findByRole("button", { name: "More" });
}

const panel = () => screen.queryByRole("tablist");
const pressCtrlBackslash = () =>
  act(() => {
    fireEvent.keyDown(window, { key: "\\", code: "Backslash", ctrlKey: true });
  });
const openTab = (name: string) => fireEvent.click(screen.getByRole("tab", { name }));

/** Make the window match the phone media query (< 768 px), as on a 390 px wide phone. */
function asPhone() {
  vi.spyOn(window, "matchMedia").mockImplementation(
    (query: string) =>
      ({
        matches: query.includes("max-width"),
        media: query,
        onchange: null,
        addListener: () => {},
        removeListener: () => {},
        addEventListener: () => {},
        removeEventListener: () => {},
        dispatchEvent: () => false,
      }) as MediaQueryList,
  );
}

beforeEach(() => {
  localStorage.clear();
  useLayoutStore.setState({
    rightOpen: false,
    rightSheetOpen: false,
    rightTab: "details",
    childThread: null,
  });
});

afterEach(() => vi.restoreAllMocks());

describe("the right panel of a session without a worktree (#409)", () => {
  it("shows the right-panel toggle for an in-place session", async () => {
    await renderShell(IN_PLACE.id, inPlaceClient());
    expect(screen.getByRole("heading", { name: IN_PLACE.purpose })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Toggle right panel" })).not.toBeNull();
  });

  it("toggles the panel with Ctrl \\", async () => {
    await renderShell(IN_PLACE.id, inPlaceClient());
    expect(panel()).toBeNull();

    pressCtrlBackslash();
    expect(useLayoutStore.getState().rightOpen).toBe(true);
    await waitFor(() => expect(panel()).not.toBeNull());

    pressCtrlBackslash();
    await waitFor(() => expect(panel()).toBeNull());
  });

  it("opens with Details, Files and Browser working in the session's folder", async () => {
    await renderShell(IN_PLACE.id, inPlaceClient());
    fireEvent.click(screen.getByRole("button", { name: "Toggle right panel" }));

    // Details: the folder it runs in, in place of a worktree.
    expect(await screen.findByText("Folder")).toBeTruthy();
    expect(screen.getAllByText(IN_PLACE.cwd).length).toBeGreaterThan(0);

    openTab("Files");
    expect(await screen.findByText("lyrics.md")).toBeTruthy();

    openTab("Browser");
    expect(await screen.findByTestId("browser-panel")).toBeTruthy();
  });

  it("explains why Diff is empty in a folder that isn't a git repository", async () => {
    await renderShell(IN_PLACE.id, inPlaceClient());
    act(() => useLayoutStore.getState().openRightTab("diff"));

    const diff = await screen.findByTestId("diff-panel");
    await within(diff).findByText("Not a git repository");
    expect(diff.textContent).toContain("No diff to show");
    expect(diff.textContent).toContain(IN_PLACE.cwd);
    // No scope picker, compare or git bar for a folder without git.
    expect(within(diff).queryByRole("button", { name: "Refresh diff" })).toBeNull();
  });

  it("says Not a git repository when the diff answers not_a_repo before git status does (#477)", async () => {
    // The server answers a non-git project folder's diff with `not_a_repo` (#452); git status
    // goes to the runner and can take longer, so the diff's answer may come first.
    let failStatus: (error: unknown) => void = () => {};
    const status = new Promise<never>((_, reject) => {
      failStatus = reject;
    });
    const client = clientWith(IN_PLACE, {
      gitStatus: () => status,
      getDiff: async () => {
        throw new ApiRequestError(
          409,
          "not_a_repo",
          `${IN_PLACE.cwd} is not a git repository, so Agent Rishi keeps no checkpoints of this session`,
        );
      },
    });
    await renderShell(IN_PLACE.id, client);
    act(() => useLayoutStore.getState().openRightTab("diff"));

    const diff = await screen.findByTestId("diff-panel");
    // Once the diff has answered, with git status still pending.
    await waitFor(() =>
      expect(diff.textContent).toMatch(/Not a git repository|Couldn't load the diff/),
    );
    expect(diff.textContent).not.toContain("Couldn't load the diff");
    expect(within(diff).getByText("Not a git repository")).toBeTruthy();
    expect(within(diff).queryByRole("button", { name: "Refresh diff" })).toBeNull();

    await act(async () => {
      failStatus(new ApiRequestError(409, "not_a_repo", `${IN_PLACE.cwd} is not a git repository`));
    });
    expect(within(diff).getByText("Not a git repository")).toBeTruthy();
  });

  it("opens a subagent in the panel, as a subagent card's Open does", async () => {
    await renderShell(IN_PLACE.id, inPlaceClient());
    act(() => useLayoutStore.getState().openChildThread(IN_PLACE.id, "t-research-1"));
    const tab = await screen.findByRole("tab", { name: "Subagent" });
    expect(tab.getAttribute("aria-selected")).toBe("true");
  });

  it("opens the panel as a sheet with its Terminal tab on a phone", async () => {
    asPhone();
    await renderShell(IN_PLACE.id, inPlaceClient());
    fireEvent.click(screen.getByRole("button", { name: "Toggle right panel" }));
    const sheet = await screen.findByTestId("right-sheet");
    expect(within(sheet).getByRole("tab", { name: "Terminal" })).toBeTruthy();
  });

  it.each(["queued", "starting"] as const)(
    "shows no panel for a %s worktree session before its worktree exists",
    async (status) => {
      // The layout's defaults: the panel open at Diff, as a new session finds it.
      useLayoutStore.setState({ rightOpen: true, rightTab: "diff" });
      const { session, gitStatus, client } = preparingClient(status);
      await renderShell(session.id, client);
      expect(screen.getByRole("heading", { name: session.purpose })).toBeTruthy();
      expect(screen.queryByRole("button", { name: "Toggle right panel" })).toBeNull();

      pressCtrlBackslash();
      pressCtrlBackslash();
      expect(useLayoutStore.getState().rightOpen).toBe(true);
      // No panel, so nothing shows (or can commit and push) the user's own checkout.
      expect(panel()).toBeNull();
      expect(screen.queryByTestId("diff-panel")).toBeNull();
      expect(screen.queryByRole("button", { name: /Commit/ })).toBeNull();
      expect(screen.queryByText("main")).toBeNull();
      expect(gitStatus).not.toHaveBeenCalled();
    },
  );

  it("keeps the panel of a worktree session", async () => {
    await renderShell("s-checkout", createMockClient());
    await screen.findByRole("button", { name: "Toggle right panel" });
    pressCtrlBackslash();
    await waitFor(() => expect(panel()).not.toBeNull());
  });
});
