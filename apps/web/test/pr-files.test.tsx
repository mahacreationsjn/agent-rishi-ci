import type { GithubPrDetails } from "@agent-rishi/contracts";
import { fireEvent, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { PrFiles, PrFilesToggle, useOpenFiles } from "@/components/github/pr-files";
import { createMockClient } from "@/lib/api/mock";
import { mockPrs } from "@/lib/api/mock/fixtures/github";
import { mockPrDiff } from "@/lib/api/mock/fixtures/github-pr-diffs";
import { renderWithClient } from "./utils";

// The real renderer needs a browser (custom elements, workers); show the patch it was given, and
// throw while rendering, as it does, when the patch holds more than one file.
vi.mock("@pierre/diffs/react", () => ({
  PatchDiff: ({ patch }: { patch: string }) => {
    if (patch.match(/^diff --git /gm)?.length !== 1) {
      throw new Error("FileDiff: Provided patch must contain exactly 1 file diff");
    }
    return <pre data-testid="patch">{patch}</pre>;
  },
}));

// PR 58: two files with patches and a binary image without one.
const pr = mockPrs.find((p) => p.number === 58) as GithubPrDetails;

function Files({ pr }: { pr: GithubPrDetails }) {
  const files = useOpenFiles();
  return (
    <>
      <PrFilesToggle pr={pr} open={files.open} onChange={files.setOpen} />
      <PrFiles pr={pr} open={files.open} onToggle={files.toggle} />
    </>
  );
}

function setup(details: GithubPrDetails = pr) {
  const client = createMockClient();
  const prDiff = vi.fn(async () => mockPrDiff(details));
  client.github.prDiff = prDiff;
  renderWithClient(<Files pr={details} />, client);
  return { prDiff };
}

describe("PR files", () => {
  it("loads the diff only when a file is opened and renders its patch", async () => {
    const { prDiff } = setup();
    expect(screen.getAllByRole("button", { expanded: false })).toHaveLength(3);
    expect(prDiff).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: /src\/theme\/tokens\.css/ }));
    expect((await screen.findByTestId("patch")).textContent).toContain(
      "+++ b/src/theme/tokens.css",
    );
    expect(prDiff).toHaveBeenCalledTimes(1);

    // A binary file: no patch from GitHub.
    fireEvent.click(screen.getByRole("button", { name: /hero\.webp/ }));
    expect(await screen.findByText(/GitHub shows no diff for this file/)).toBeTruthy();
    expect(prDiff).toHaveBeenCalledTimes(1);
  });

  it("expands and collapses every file", async () => {
    setup();
    fireEvent.click(screen.getByRole("button", { name: "Expand all" }));
    expect(await screen.findAllByTestId("patch")).toHaveLength(2);
    expect(screen.getAllByRole("button", { expanded: true })).toHaveLength(3);
    fireEvent.click(screen.getByRole("button", { name: "Collapse all" }));
    expect(screen.queryAllByTestId("patch")).toHaveLength(0);
  });

  it("shows a fallback for a file whose diff fails to render, and keeps the other files", async () => {
    // React reports the caught render error on the console.
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    const client = createMockClient();
    client.github.prDiff = vi.fn(async () => {
      const diff = mockPrDiff(pr);
      const files = diff.files.map((f) =>
        f.path === "src/theme/tokens.css" ? { ...f, patch: `${f.patch}diff --git a/x b/x\n` } : f,
      );
      return { ...diff, files };
    });
    renderWithClient(<Files pr={pr} />, client);

    fireEvent.click(screen.getByRole("button", { name: "Expand all" }));
    expect(await screen.findByText(/Couldn't render this file's diff/)).toBeTruthy();
    const broken = document.querySelector('[data-file="src/theme/tokens.css"]') as HTMLElement;
    expect(within(broken).getByText(/Couldn't render this file's diff/)).toBeTruthy();
    expect(within(broken).getByRole("button", { name: /Open on GitHub/ })).toBeTruthy();
    // The other file's diff and every row still render.
    expect(screen.getAllByTestId("patch")).toHaveLength(1);
    expect(screen.getAllByText(/Couldn't render this file's diff/)).toHaveLength(1);
    expect(screen.getAllByRole("button", { expanded: true })).toHaveLength(3);
    consoleError.mockRestore();
  });

  it("says when GitHub listed only part of the files", () => {
    setup({ ...pr, changedFiles: 3500 });
    expect(screen.getByText(/GitHub lists the first 3 of 3500 files/)).toBeTruthy();
  });
});
