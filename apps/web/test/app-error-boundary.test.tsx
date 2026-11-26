import { render, screen } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import { AppErrorBoundary } from "@/components/common/app-error-boundary";

function BrokenApp(): never {
  throw new Error("private start error");
}

it("shows a reload action instead of a blank page when the app throws", () => {
  const error = vi.spyOn(console, "error").mockImplementation(() => {});
  try {
    render(
      <AppErrorBoundary>
        <BrokenApp />
      </AppErrorBoundary>,
    );
    expect(screen.getByRole("alert").textContent).toContain("Agent Rishi could not load");
    expect(screen.getByRole("button", { name: "Reload" })).toBeTruthy();
    expect(screen.queryByText("private start error")).toBeNull();
  } finally {
    error.mockRestore();
  }
});
