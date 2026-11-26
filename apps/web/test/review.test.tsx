import type { ProviderInfo, Session, SetupCheck } from "@agent-rishi/contracts";
import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { providerAvailability } from "@/components/composer/model-picker/logic";
import {
  initialReviewChoice,
  ReviewDialog,
  reviewTargetProblem,
} from "@/components/thread/review-dialog";
import { createMockClient } from "@/lib/api/mock";
import { sessions as fixtureSessions } from "@/lib/api/mock/fixtures/sessions";
import { providers } from "@/lib/api/mock/fixtures/world";
import { canReview, NOT_A_REPO_ACTION_REASON, reviewBlocked } from "@/lib/session-actions";
import { useUiStore } from "@/stores/ui";
import { renderWithClient } from "./utils";

/** "Review with another agent" (§9, #356): a read-only second opinion on a session's changes. */

const toast = vi.hoisted(() =>
  Object.assign(vi.fn(), {
    success: vi.fn(),
    error: vi.fn(),
    warning: vi.fn(),
    loading: vi.fn(() => "loading-1"),
  }),
);
vi.mock("sonner", () => ({ toast }));

afterEach(() => act(() => useUiStore.getState().setReview(null)));

/** A fixture agent session that has done some work and isn't running. */
const finished = (() => {
  const found = fixtureSessions.find(
    (s) => s.role === "agent" && s.status === "completed" && s.branch && s.rootThreadId,
  );
  if (!found) throw new Error("no finished fixture session");
  return found;
})();

const idle: Session = { ...finished, status: "idle", forkedFrom: null };
const provider = (id: string) => providers.find((p) => p.id === id) as ProviderInfo;
const withoutReadOnly = (p: ProviderInfo, name = "Plain"): ProviderInfo => ({
  ...p,
  id: name.toLowerCase(),
  displayName: name,
  capabilities: { ...p.capabilities, readOnly: false },
});
const signedOut = (id: string): SetupCheck => ({
  id: id as SetupCheck["id"],
  label: id,
  state: "missing",
  installed: true,
  version: null,
  executablePath: null,
  loggedIn: false,
  authMethod: null,
  account: null,
  loginExpiresAt: null,
  message: "",
  fix: null,
  durationMs: 1,
});

describe("reviewing a session with another agent", () => {
  it("is offered for agent sessions that aren't reviews themselves", () => {
    expect(canReview(idle)).toBe(true);
    expect(canReview({ ...idle, role: "pm" })).toBe(false);
    expect(
      canReview({ ...idle, forkedFrom: { sessionId: "s0", checkpoint: 1, kind: "review" } }),
    ).toBe(false);
    // Forks and handoffs have changes of their own to review.
    expect(
      canReview({ ...idle, forkedFrom: { sessionId: "s0", checkpoint: 1, kind: "handoff" } }),
    ).toBe(true);
  });

  it("is blocked while a turn runs, before it starts, without a branch or without work", () => {
    expect(reviewBlocked(idle, 2)).toBeNull();
    for (const status of ["failed", "stopped", "interrupted", "completed"] as const) {
      expect(reviewBlocked({ ...idle, status }, 2)).toBeNull();
    }
    expect(reviewBlocked({ ...idle, status: "running" }, 2)).toMatch(/running turn/);
    expect(reviewBlocked({ ...idle, status: "waiting" }, 2)).toMatch(/waiting on/);
    expect(reviewBlocked({ ...idle, status: "starting" }, 0)).toMatch(/hasn't started/);
    expect(reviewBlocked({ ...idle, branch: null }, 2)).toMatch(/git branch/);
    expect(reviewBlocked(idle, 0)).toMatch(/No changes to review/);
    // Unknown here: the server decides.
    expect(reviewBlocked(idle, undefined)).toBeNull();
  });

  it("never reviews in a project whose folder isn't a git repository, and says so first (#424)", () => {
    const notGit = { isGitRepo: false };
    expect(reviewBlocked(idle, 2, notGit)).toBe(NOT_A_REPO_ACTION_REASON);
    expect(reviewBlocked({ ...idle, status: "waiting" }, 2, notGit)).toBe(NOT_A_REPO_ACTION_REASON);
    expect(reviewBlocked({ ...idle, branch: null }, 0, notGit)).toBe(NOT_A_REPO_ACTION_REASON);
    expect(reviewBlocked(idle, 2, { isGitRepo: true })).toBeNull();
    expect(reviewBlocked(idle, 0, undefined)).toMatch(/No changes to review/);
  });

  it("starts on another provider that can run and enforce read-only, else the session's own", () => {
    const claude = { ...idle, provider: "claude", model: "opus", effort: "high" as const };
    const others = providers.filter((p) => p.id !== "claude");
    const [first, second] = others;
    if (!first || !second) throw new Error("need two other providers");
    expect(initialReviewChoice(claude, providers, null).provider).not.toBe("claude");
    // A provider that can't enforce read-only is never the default, even when asked for.
    const plain = withoutReadOnly(first);
    const list = [provider("claude"), plain, ...others.slice(1)];
    expect(initialReviewChoice(claude, list, null).provider).toBe(second.id);
    expect(initialReviewChoice(claude, list, plain.id).provider).not.toBe(plain.id);
    // The first other provider isn't signed in: the next one is chosen.
    expect(initialReviewChoice(claude, providers, null, [signedOut(first.id)]).provider).toBe(
      second.id,
    );
    // Only the session's own provider can review: it keeps the model and effort.
    expect(initialReviewChoice(claude, [provider("claude"), plain], null)).toEqual({
      provider: "claude",
      model: "opus",
      effort: "high",
    });
  });

  it("refuses a provider that can't start or can't enforce read-only, with the reason", () => {
    const codex = provider("codex");
    expect(reviewTargetProblem(codex, providerAvailability("codex", [signedOut("codex")]))).toBe(
      "Codex can't start sessions: not signed in.",
    );
    expect(reviewTargetProblem(codex, providerAvailability("codex", []))).toBeNull();
    expect(reviewTargetProblem(withoutReadOnly(codex))).toBe(
      "Plain can't run read-only sessions, so it can't review.",
    );
  });

  it("starts the review through the client with the focus, then opens it", async () => {
    const client = createMockClient();
    const review = vi.spyOn(client, "reviewSession");
    // Another provider that is signed in (the mock's Codex isn't).
    const other = providers.find(
      (p) => p.id !== finished.provider && p.id !== "codex" && p.capabilities.readOnly,
    ) as ProviderInfo;
    renderWithClient(<ReviewDialog />, client, { withRouter: true });
    act(() => useUiStore.getState().setReview({ sessionId: finished.id, provider: other.id }));

    const dialog = await screen.findByTestId("review-dialog");
    expect(within(dialog).getByText("Review with another agent")).toBeTruthy();
    fireEvent.change(within(dialog).getByLabelText(/What should it focus on/), {
      target: { value: "  The error handling.  " },
    });
    fireEvent.click(
      within(dialog).getByRole("button", { name: `Start review on ${other.displayName}` }),
    );

    await waitFor(() =>
      expect(review).toHaveBeenCalledWith(finished.id, {
        provider: other.id,
        focus: "The error handling.",
      }),
    );
    expect(toast.loading).toHaveBeenCalledWith("Starting the review…");
    await waitFor(() =>
      expect(toast.success).toHaveBeenCalledWith(
        `${other.displayName} is reviewing this session's changes`,
        expect.objectContaining({ id: "loading-1" }),
      ),
    );
    await waitFor(() => expect(useUiStore.getState().review).toBeNull());
    const created = (await client.getSnapshot()).sessions.find(
      (s) => s.forkedFrom?.sessionId === finished.id && s.forkedFrom.kind === "review",
    );
    expect(created).toMatchObject({ autonomy: "read_only", provider: other.id });
  });

  it("says why it can't review a running session, and doesn't try", async () => {
    const client = createMockClient();
    const review = vi.spyOn(client, "reviewSession");
    const running = fixtureSessions.find((s) => s.role === "agent" && s.status === "running");
    if (!running) throw new Error("no running fixture session");
    renderWithClient(<ReviewDialog />, client, { withRouter: true });
    act(() => useUiStore.getState().setReview({ sessionId: running.id, provider: null }));
    const dialog = await screen.findByTestId("review-dialog");
    expect(within(dialog).getByRole("status").textContent).toMatch(/running turn/);
    const submit = within(dialog).getByRole("button", { name: /^Start review on/ });
    expect((submit as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(submit);
    expect(review).not.toHaveBeenCalled();
  });
});
