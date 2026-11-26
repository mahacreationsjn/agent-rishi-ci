import { render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { lazyComponent } from "@/components/common/lazy-component";
import { ErrorBoundary } from "@/components/error-boundary";
import { isChunkLoadError } from "@/lib/chunk-error";

// React logs the errors the boundaries catch; keep the test output readable.
const quiet = () => vi.spyOn(console, "error").mockImplementation(() => {});
afterEach(() => vi.restoreAllMocks());

function Greeting({ name }: { name: string }) {
  return <p>Hello {name}</p>;
}

function Broken(): never {
  throw new Error("boom");
}

describe("isChunkLoadError", () => {
  it("knows each browser's failed dynamic import, and Vite's failed chunk stylesheet", () => {
    for (const message of [
      "Failed to fetch dynamically imported module: http://192.168.1.5:4318/assets/diff-panel-x.js",
      "error loading dynamically imported module: http://localhost/assets/terminal-view-y.js",
      "Importing a module script failed.",
      "Unable to preload CSS for /assets/terminal-view-z.css",
    ]) {
      expect(isChunkLoadError(new Error(message))).toBe(true);
    }
  });

  it("leaves other errors alone", () => {
    expect(isChunkLoadError(new TypeError("Cannot read properties of undefined"))).toBe(false);
    expect(isChunkLoadError("Failed to fetch dynamically imported module")).toBe(false);
    expect(isChunkLoadError(undefined)).toBe(false);
  });
});

describe("lazyComponent", () => {
  it("shows the fallback, then the component once its chunk arrives", async () => {
    const LazyGreeting = lazyComponent(async () => Greeting, <p>Loading…</p>);
    render(<LazyGreeting name="Ada" />);
    expect(screen.getByText("Loading…")).toBeTruthy();
    expect(await screen.findByText("Hello Ada")).toBeTruthy();
  });

  it("offers a reload when the chunk can't be fetched (Agent Rishi was updated), not a blank panel", async () => {
    quiet();
    const Panel = lazyComponent<object>(() =>
      Promise.reject(
        new TypeError("Failed to fetch dynamically imported module: /assets/diff-panel-old.js"),
      ),
    );
    render(<Panel />);
    expect((await screen.findByRole("alert")).textContent).toMatch(/didn't load/);
    expect(screen.getByRole("button", { name: /reload/i })).toBeTruthy();
  });

  it("passes a bug in the loaded code on to the boundaries above", async () => {
    quiet();
    const LazyBroken = lazyComponent<object>(async () => Broken);
    render(
      <ErrorBoundary fallback={<p>Outer boundary</p>}>
        <LazyBroken />
      </ErrorBoundary>,
    );
    expect(await screen.findByText("Outer boundary")).toBeTruthy();
    expect(screen.queryByRole("button", { name: /reload/i })).toBeNull();
  });
});
