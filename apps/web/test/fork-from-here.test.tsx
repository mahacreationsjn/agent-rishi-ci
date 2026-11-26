import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { ForkFromHere } from "@/components/thread/fork-from-here";
import { createMockClient } from "@/lib/api/mock";
import { useSession } from "@/lib/queries";
import { renderWithClient } from "./utils";

const toast = vi.hoisted(() => Object.assign(vi.fn(), { loading: vi.fn() }));
vi.mock("sonner", () => ({ toast }));

/** The latest finished turn of `s-search`'s own thread; the session itself is still running. */
const row = {
  key: "end:u1",
  type: "turn-end",
  filesChanged: 0,
  durationMs: null,
  latest: true,
  turn: {
    id: "u1",
    threadId: "t-search",
    status: "completed",
    startedAt: "2026-11-12T10:00:00.000Z",
    completedAt: "2026-11-12T10:01:00.000Z",
    error: null,
    forkPoint: null,
  },
} as const;

describe("Fork from here", () => {
  it("says why it can't fork when pressed, not only in a hover tooltip", async () => {
    const reason = "Wait for the running turn to finish";
    const user = userEvent.setup();
    const client = createMockClient();
    const fork = vi.spyOn(client, "forkSession");
    renderWithClient(<ForkFromHere sessionId="s-search" row={row} />, client, {
      withRouter: true,
    });
    const button = await screen.findByRole("button", { name: /Fork from here/ });

    // A tap or click, then Enter and Space from the keyboard: each says why, none forks.
    await user.click(button);
    expect(toast).toHaveBeenLastCalledWith(reason, expect.anything());
    toast.mockClear();
    button.focus();
    await user.keyboard("{Enter}");
    expect(toast).toHaveBeenLastCalledWith(reason, expect.anything());
    toast.mockClear();
    await user.keyboard(" ");
    expect(toast).toHaveBeenLastCalledWith(reason, expect.anything());
    expect(fork).not.toHaveBeenCalled();

    // Assistive tech is told why too.
    const describedBy = button.getAttribute("aria-describedby");
    expect(describedBy && document.getElementById(describedBy)?.textContent).toBe(reason);
  });

  it("isn't offered in a project whose folder isn't a git repository (#424)", async () => {
    const base = createMockClient();
    const client = {
      ...base,
      getSnapshot: async () => {
        const snapshot = await base.getSnapshot();
        const projects = snapshot.projects.map((p) => ({ ...p, isGitRepo: false }));
        return { ...snapshot, projects };
      },
    };
    renderWithClient(
      <>
        <ForkFromHere sessionId="s-search" row={row} />
        <SnapshotLoaded />
      </>,
      client,
      { withRouter: true },
    );
    await screen.findByText("loaded");
    expect(screen.queryByRole("button", { name: /Fork from here/ })).toBeNull();
  });
});

/** Shows "loaded" once the snapshot (with `s-search` and its project) has loaded. */
function SnapshotLoaded() {
  return useSession("s-search") ? <span>loaded</span> : null;
}
