import type { Session } from "@agent-rishi/contracts";
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { SessionOptions } from "@/components/composer/session-options";
import { createMockClient } from "@/lib/api/mock";
import { makeSession } from "@/lib/api/mock/fixtures/helpers";
import { snapshotKey } from "@/lib/queries";
import { renderWithClient } from "./utils";

const toast = vi.hoisted(() =>
  Object.assign(vi.fn(), { success: vi.fn(), error: vi.fn(), warning: vi.fn() }),
);
vi.mock("sonner", () => ({ toast }));

/** A mock client whose projects' folders aren't git repositories (`isGitRepo: false`). */
function notGitClient() {
  const base = createMockClient();
  return {
    ...base,
    getSnapshot: async () => {
      const snapshot = await base.getSnapshot();
      const projects = snapshot.projects.map((p) => ({ ...p, isGitRepo: false }));
      return { ...snapshot, projects };
    },
  };
}

describe("the model picker's handoff tiles in a project that isn't a git repository (#446)", () => {
  it("doesn't say the handoff is unavailable only for now", async () => {
    // A finished Codex session that ran in the project folder itself: no worktree, no branch.
    const session: Session = makeSession({
      id: "s-in-place",
      projectId: "p-storefront",
      role: "agent",
      status: "idle",
      provider: "codex",
      model: "default",
      purpose: "Tidy the README",
      workKey: "adhoc:tidy-readme",
    });
    const { queryClient } = renderWithClient(
      <SessionOptions session={session} running={false} />,
      notGitClient(),
      { withRouter: true },
    );
    await waitFor(() => expect(queryClient.getQueryData(snapshotKey)).toBeTruthy());

    fireEvent.click(await screen.findByRole("button", { name: /^Provider and model/ }));
    const picker = await screen.findByTestId("model-picker");
    const rail = within(picker).getByRole("toolbar", { name: "Providers" });
    // Claude Code's tile, once the project is known not to be a git repository.
    const claude = await waitFor(() =>
      within(rail).getByRole("button", { name: /Claude Code.*isn't a git repository/ }),
    );
    const label = claude.getAttribute("aria-label") ?? "";

    // The folder won't become a repository when a turn ends: nothing here may read as temporary.
    expect(label).not.toMatch(/not available now/i);
    expect(label).toBe(
      "Can't hand off to Claude Code: the project folder isn't a git repository. Start a new session to switch providers.",
    );
    // And the tile stays disabled: no handoff can ever run in this project.
    expect(claude.getAttribute("aria-disabled")).toBe("true");
  });
});
