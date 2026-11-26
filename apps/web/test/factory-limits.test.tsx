import type { Project } from "@agent-rishi/contracts";
import { fireEvent, screen, waitFor } from "@testing-library/react";
import { toast } from "sonner";
import { describe, expect, it, vi } from "vitest";
import { AutonomyDialog } from "@/components/factory/autonomy-dialog";
import { createMockClient } from "@/lib/api/mock";
import { projects } from "@/lib/api/mock/fixtures/world";
import { renderWithClient } from "./utils";

const storefront = projects.find((p) => p.id === "p-storefront") as Project;

describe("factory settings in the autonomy dialog", () => {
  it("shows the size limits, saves an empty box as no limit and keeps valid trusted authors", async () => {
    const success = vi.spyOn(toast, "success").mockImplementation(() => "t");
    const client = createMockClient();
    const setMode = vi.spyOn(client.factory, "setMode");
    renderWithClient(<AutonomyDialog project={storefront} open onOpenChange={() => {}} />, client, {
      withRouter: true,
    });

    const lines = (await screen.findByLabelText("Largest change (lines)")) as HTMLInputElement;
    await waitFor(() => expect(lines.value).toBe("5000"));
    const files = screen.getByLabelText("Most files changed") as HTMLInputElement;
    expect(files.value).toBe("");
    expect(files.placeholder).toBe("No limit");
    expect(screen.getByText(/Lockfiles and generated files don't count/)).toBeTruthy();

    fireEvent.change(lines, { target: { value: "" } });
    fireEvent.change(files, { target: { value: "120" } });
    const authors = screen.getByLabelText("Trusted authors") as HTMLTextAreaElement;
    fireEvent.change(authors, { target: { value: "@octocat\n-not-a-login!\nmy-teammate" } });
    fireEvent.click(screen.getByRole("button", { name: "Save settings" }));

    await waitFor(() => expect(setMode).toHaveBeenCalled());
    expect(setMode.mock.calls[0]?.[1]).toMatchObject({
      mode: "dark_factory",
      limits: { autoMerge: false, trustedAuthors: ["octocat", "my-teammate"] },
      tuning: { maxChangedLines: null, maxChangedFiles: 120, requireCi: true },
    });
    success.mockRestore();
  });

  it("edits the scout's backlog threshold and the other knobs without resetting the rest", async () => {
    const success = vi.spyOn(toast, "success").mockImplementation(() => "t");
    const client = createMockClient();
    const setMode = vi.spyOn(client.factory, "setMode");
    renderWithClient(<AutonomyDialog project={storefront} open onOpenChange={() => {}} />, client, {
      withRouter: true,
    });

    const backlog = (await screen.findByLabelText("Review when fewer than")) as HTMLInputElement;
    await waitFor(() => expect(backlog.value).toBe("2"));
    expect(screen.getByText("issues wait for an agent.")).toBeTruthy();
    fireEvent.change(backlog, { target: { value: "0" } });
    expect(screen.getByText("Off: only Run scout now starts a round.")).toBeTruthy();
    // A negative number isn't a threshold: on blur the box is clamped to 0, with a note.
    fireEvent.change(backlog, { target: { value: "-3" } });
    fireEvent.blur(backlog);
    expect(backlog.value).toBe("0");
    expect(screen.getByText("The least is 0.")).toBeTruthy();
    fireEvent.change(screen.getByLabelText("Revise rounds"), { target: { value: "4" } });
    fireEvent.change(screen.getByLabelText("Watch main CI (minutes)"), { target: { value: "45" } });
    fireEvent.change(screen.getByLabelText("When the reviewer's provider is unavailable"), {
      target: { value: "wait" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save settings" }));

    await waitFor(() => expect(setMode).toHaveBeenCalled());
    const tuning = setMode.mock.calls[0]?.[1].tuning;
    expect(tuning).toMatchObject({
      minBacklog: 0,
      maxFixAttempts: 4,
      watchTimeoutMin: 45,
      // Unchanged knobs keep their saved values.
      discoveryIntervalMin: 360,
      maxIssuesPerRound: 3,
      maxChangedLines: 5000,
      requireCi: true,
      reviewerFallback: "wait",
      reviewerProvider: "auto",
      reviewerModel: null,
    });
    // Knobs the editor doesn't show aren't sent, so the server keeps what it has.
    expect(tuning).not.toHaveProperty("areas");
    expect(tuning).not.toHaveProperty("idleGraceMin");
    success.mockRestore();
  });

  it("routes docs builds and the scout to a provider and model of their own (#384)", async () => {
    const success = vi.spyOn(toast, "success").mockImplementation(() => "t");
    const client = createMockClient();
    const setMode = vi.spyOn(client.factory, "setMode");
    renderWithClient(<AutonomyDialog project={storefront} open onOpenChange={() => {}} />, client, {
      withRouter: true,
    });

    const docs = (await screen.findByLabelText("Docs builder provider")) as HTMLSelectElement;
    // The providers come from the runner's list in the snapshot.
    await waitFor(() => expect(docs.querySelector('option[value="claude"]')).toBeTruthy());
    expect(docs.value).toBe("");
    expect(docs.selectedOptions[0]?.textContent).toBe("Same as builders");
    const docsModel = screen.getByLabelText("Docs builder model") as HTMLSelectElement;
    expect(docsModel.disabled).toBe(true);
    fireEvent.change(docs, { target: { value: "claude" } });
    fireEvent.change(docsModel, { target: { value: "haiku" } });

    const scout = screen.getByLabelText("Scout provider") as HTMLSelectElement;
    expect(scout.value).toBe("auto");
    fireEvent.change(scout, { target: { value: "codex" } });
    fireEvent.change(screen.getByLabelText("Scout model"), {
      target: { value: "gpt-6.1-sol-mini" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save settings" }));

    await waitFor(() => expect(setMode).toHaveBeenCalled());
    expect(setMode.mock.calls[0]?.[1].tuning).toMatchObject({
      docsBuilderProvider: "claude",
      docsBuilderModel: "haiku",
      scoutProvider: "codex",
      scoutModel: "gpt-6.1-sol-mini",
      // Feature and bug builds keep the builder's choice.
      builderProvider: "auto",
      builderModel: null,
    });
    success.mockRestore();
  });
});
