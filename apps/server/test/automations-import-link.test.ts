import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  AUTOMATION_IMPORT_LIMITS,
  AutomationImportLinkResponse,
  ImportAutomationsResponse,
} from "@agent-rishi/contracts";
import { strToU8, zipSync } from "fflate";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type RunningServer, startServer } from "../src";
import { PrivateAddressError } from "../src/network/public-fetch";
import { planImportLink, resolveImportLink } from "../src/services/automations/import-link";
import type { Exec } from "../src/services/exec";
import { removeTree } from "./support/remove-tree";

const automation = (name: string, autonomy = "read_only") =>
  [
    "---",
    `name: ${name}`,
    "trigger:",
    "  type: manual",
    "action: start_session",
    `autonomy: ${autonomy}`,
    "---",
    `Do the ${name.toLowerCase()} for {{project.name}}.`,
  ].join("\n");

type Answer = (init: RequestInit) => Response;

/** A fetch that answers from a table of URLs (404 otherwise) and records every request. */
function scripted(routes: Record<string, Answer>) {
  const calls: { url: string; init: RequestInit }[] = [];
  const fetch = (async (input: string | URL | Request, init: RequestInit = {}) => {
    const url = input instanceof Request ? input.url : String(input);
    calls.push({ url, init });
    const answer = routes[url];
    return answer
      ? answer(init)
      : new Response("missing", { status: 404, statusText: "Not Found" });
  }) as typeof globalThis.fetch;
  return { fetch, calls };
}

const text =
  (body: string | Uint8Array, headers: Record<string, string> = {}): Answer =>
  () =>
    new Response(body, { headers: { "content-type": "text/plain; charset=utf-8", ...headers } });
const redirect =
  (location: string): Answer =>
  () =>
    new Response(null, { status: 302, headers: { location } });

const resolve = (url: string, routes: Record<string, Answer>) =>
  resolveImportLink(url, { fetch: scripted(routes).fetch });

describe("planning a link", () => {
  it("reads GitHub file pages from their raw address and gists from GitHub's API", () => {
    expect(
      planImportLink("https://github.com/acme/automations/blob/main/ops/release.md?plain=1#L3"),
    ).toEqual({
      kind: "file",
      url: new URL("https://raw.githubusercontent.com/acme/automations/main/ops/release.md"),
    });
    expect(planImportLink("https://github.com/acme/automations/raw/v1.2/a%20b.md")).toMatchObject({
      url: new URL("https://raw.githubusercontent.com/acme/automations/v1.2/a%20b.md"),
    });
    expect(planImportLink("https://gist.github.com/someone/0123abcd#file-a-md")).toEqual({
      kind: "gist",
      id: "0123abcd",
    });
    expect(planImportLink("https://gist.github.com/0123abcd")).toEqual({
      kind: "gist",
      id: "0123abcd",
    });
    const revision = "f".repeat(40);
    expect(planImportLink(`https://gist.github.com/someone/0123abcd/${revision}`)).toEqual({
      kind: "gist",
      id: "0123abcd",
      revision,
    });
    expect(planImportLink("https://gist.github.com/someone/0123abcd/raw/a.md")).toMatchObject({
      kind: "file",
    });
    for (const link of [
      "https://github.com/acme/automations/archive/refs/heads/main.zip",
      "https://github.com/acme/automations/releases/download/v1/automations.zip",
    ]) {
      expect(planImportLink(link)).toEqual({ kind: "file", url: new URL(link) });
    }
  });

  it("refuses links that aren't https, and GitHub pages that aren't a file or a gist", () => {
    for (const link of [
      "not a link",
      "http://example.com/a.md",
      "file:///etc/passwd",
      "https://me:secret@example.com/a.md",
      "https://github.com/acme/automations",
      "https://github.com/acme/automations/tree/main/.agent-rishi/automations",
      "https://github.com/acme/automations/issues/3",
      "https://gist.github.com/someone",
      "https://gist.github.com/someone/0123abcd/revisions",
    ]) {
      expect(() => planImportLink(link), link).toThrow(
        expect.objectContaining({ status: 400, code: "invalid_link" }),
      );
    }
    expect(() => planImportLink("http://example.com/a.md")).toThrow(/a GitHub file or a gist/);
  });

  it("refuses links to this computer or a private network, by name or address", () => {
    for (const link of [
      "https://localhost/a.md",
      "https://app.localhost/a.md",
      "https://127.0.0.1/a.md",
      "https://2130706433/a.md",
      "https://[::1]/a.md",
      "https://192.168.1.10/team/a.md",
      "https://10.0.0.8/a.md",
      "https://169.254.169.254/latest/meta-data",
      "https://[fd00::1]/a.md",
    ]) {
      expect(() => planImportLink(link), link).toThrow(
        expect.objectContaining({
          status: 400,
          code: "invalid_link",
          message: expect.stringMatching(/this computer or a private network/),
        }),
      );
    }
  });
});

describe("downloading a link", () => {
  it("downloads a .md file once, sending no credentials", async () => {
    const { fetch, calls } = scripted({
      "https://example.com/shared/release-notes.md": text(automation("Release notes")),
    });
    const files = await resolveImportLink("https://example.com/shared/release-notes.md", {
      fetch,
    });
    expect(files).toEqual([{ name: "release-notes.md", content: automation("Release notes") }]);
    expect(calls).toHaveLength(1);
    const init = calls[0]?.init ?? {};
    expect(init.redirect).toBe("manual");
    expect(Object.keys(init.headers ?? {}).sort()).toEqual(["accept", "user-agent"]);
  });

  it("downloads a GitHub file page from raw.githubusercontent.com", async () => {
    const { fetch, calls } = scripted({
      "https://raw.githubusercontent.com/acme/automations/main/ops/triage.md": text(
        automation("Triage"),
      ),
    });
    const files = await resolveImportLink(
      "https://github.com/acme/automations/blob/main/ops/triage.md",
      { fetch },
    );
    expect(files.map((f) => f.name)).toEqual(["triage.md"]);
    expect(calls.map((c) => c.url)).toEqual([
      "https://raw.githubusercontent.com/acme/automations/main/ops/triage.md",
    ]);
  });

  it("takes a gist's .md files and ignores the rest", async () => {
    const gist = {
      files: {
        "audit.md": { filename: "audit.md", content: automation("Audit") },
        "notes.txt": { filename: "notes.txt", content: "not an automation" },
        "Sweep.MD": { filename: "Sweep.MD", content: automation("Sweep") },
      },
    };
    const { fetch, calls } = scripted({
      "https://api.github.com/gists/0123abcd": text(JSON.stringify(gist)),
    });
    const files = await resolveImportLink("https://gist.github.com/someone/0123abcd", { fetch });
    expect(files.map((f) => f.name)).toEqual(["audit.md", "Sweep.MD"]);
    expect(calls[0]?.init.headers).toMatchObject({ accept: "application/vnd.github+json" });

    const truncated = { files: { "big.md": { filename: "big.md", truncated: true } } };
    await expect(
      resolve("https://gist.github.com/0123abcd", {
        "https://api.github.com/gists/0123abcd": text(JSON.stringify(truncated)),
      }),
    ).rejects.toMatchObject({ status: 413, code: "import_too_large" });
  });

  it("unpacks a zip by its signature, whatever its address or content type", async () => {
    const zip = zipSync({
      "pack/one.md": strToU8(automation("One")),
      "pack/readme.txt": strToU8("ignored"),
      "pack/two.md": strToU8(automation("Two")),
    });
    const files = await resolve("https://example.com/download?id=7", {
      "https://example.com/download?id=7": text(zip, {
        "content-type": "application/octet-stream",
      }),
    });
    expect(files.map((f) => f.name)).toEqual(["one.md", "two.md"]);
    await expect(
      resolve("https://example.com/pack.zip", {
        "https://example.com/pack.zip": text("not a zip"),
      }),
    ).rejects.toMatchObject({ status: 400, code: "invalid_zip" });
  });

  it("follows https redirects, names the file after where it landed, and refuses http", async () => {
    const files = await resolve("https://short.example/x", {
      "https://short.example/x": redirect("https://cdn.example/files/weekly%20audit.md"),
      "https://cdn.example/files/weekly%20audit.md": text(automation("Weekly audit")),
    });
    expect(files.map((f) => f.name)).toEqual(["weekly audit.md"]);
    await expect(
      resolve("https://short.example/y", {
        "https://short.example/y": redirect("http://cdn.example/a.md"),
      }),
    ).rejects.toMatchObject({ status: 400, code: "invalid_link" });
    await expect(
      resolve("https://short.example/z", {
        "https://short.example/z": redirect("https://169.254.169.254/latest/meta-data"),
      }),
    ).rejects.toMatchObject({
      status: 400,
      code: "invalid_link",
      message: expect.stringMatching(/^short\.example redirected to this computer or a private/),
    });
    const loop = Object.fromEntries(
      Array.from({ length: 10 }, (_, i) => [
        `https://loop.example/${i}`,
        redirect(`https://loop.example/${i + 1}`),
      ]),
    );
    await expect(resolve("https://loop.example/0", loop)).rejects.toMatchObject({
      status: 502,
      message: expect.stringMatching(/redirected more than/),
    });
  });

  it("refuses a web page instead of a file", async () => {
    await expect(
      resolve("https://example.com/automation", {
        "https://example.com/automation": text("<p>hi</p>", { "content-type": "text/html" }),
      }),
    ).rejects.toMatchObject({ status: 400, code: "link_not_a_file" });
    await expect(
      resolve("https://example.com/page.md", {
        "https://example.com/page.md": text("<!DOCTYPE html><html><body>hi</body></html>"),
      }),
    ).rejects.toMatchObject({ status: 400, code: "link_not_a_file" });
  });

  it("refuses oversized downloads by their declared length and as they arrive", async () => {
    const limit = AUTOMATION_IMPORT_LIMITS.maxZipBytes;
    await expect(
      resolve("https://example.com/a.md", {
        "https://example.com/a.md": text("x", { "content-length": String(limit + 1) }),
      }),
    ).rejects.toMatchObject({ status: 413, code: "import_too_large" });
    const stream = () =>
      new Response(
        new ReadableStream({
          pull(controller) {
            controller.enqueue(new Uint8Array(64 * 1024));
          },
        }),
      );
    await expect(
      resolve("https://example.com/endless.md", { "https://example.com/endless.md": stream }),
    ).rejects.toMatchObject({ status: 413, code: "import_too_large" });
    const long = `${automation("Long")}\n${"y".repeat(AUTOMATION_IMPORT_LIMITS.maxFileChars)}`;
    await expect(
      resolve("https://example.com/long.md", { "https://example.com/long.md": text(long) }),
    ).rejects.toMatchObject({ status: 413, message: expect.stringMatching(/long\.md/) });
  });

  it("names the host when the download fails", async () => {
    await expect(
      resolve("https://github.com/acme/private/blob/main/a.md", {}),
    ).rejects.toMatchObject({
      status: 502,
      code: "link_fetch_failed",
      message:
        "raw.githubusercontent.com answered 404 Not Found (only public files and gists can be imported)",
    });
    const offline = (async () => {
      throw new TypeError("fetch failed", {
        cause: new Error("getaddrinfo ENOTFOUND nowhere.example"),
      });
    }) as typeof fetch;
    await expect(
      resolveImportLink("https://nowhere.example/a.md", { fetch: offline }),
    ).rejects.toMatchObject({
      status: 502,
      message: "Couldn't reach nowhere.example: getaddrinfo ENOTFOUND nowhere.example",
    });
    // A name that resolves to a private address is refused when connecting: a 400, not a 502.
    const intranet = (async () => {
      throw new TypeError("fetch failed", { cause: new PrivateAddressError("intranet.example") });
    }) as typeof fetch;
    await expect(
      resolveImportLink("https://intranet.example/a.md", { fetch: intranet }),
    ).rejects.toMatchObject({
      status: 400,
      code: "invalid_link",
      message: expect.stringMatching(/^intranet\.example leads to this computer or a private/),
    });
    await expect(
      resolve("https://gist.github.com/0123abcd", {
        "https://api.github.com/gists/0123abcd": () =>
          new Response("{}", { status: 403, headers: { "x-ratelimit-remaining": "0" } }),
      }),
    ).rejects.toMatchObject({ status: 502, message: expect.stringMatching(/GitHub's limit/) });
  });
});

describe("POST /api/automations/import/link", () => {
  const TOKEN = "b".repeat(64);
  const notFound: Exec = async () => ({
    code: null,
    stdout: "",
    stderr: "",
    notFound: true,
    timedOut: false,
    path: null,
  });
  const routes: Record<string, Answer> = {};
  const download = scripted(routes);
  let home: string;
  let server: RunningServer;

  beforeAll(async () => {
    home = mkdtempSync(join(tmpdir(), "agent-rishi-import-link-"));
    server = await startServer({
      port: 0,
      dataDir: join(home, "data"),
      token: TOKEN,
      runner: false,
      secrets: "memory",
      checkSetupOnStart: false,
      exec: notFound,
      userHome: join(home, "user"),
      automations: { rescanMs: 0, fetch: download.fetch },
    });
  });
  afterAll(async () => {
    await server?.close();
    await removeTree(home);
  });

  const call = async (path: string, body: unknown) => {
    const res = await fetch(`${server.url}/api${path}`, {
      method: "POST",
      headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    return { status: res.status, body: (await res.json()) as unknown };
  };

  it("previews a link, then imports exactly what was previewed, off, without downloading again", async () => {
    const url = "https://example.com/team/nightly.md";
    routes[url] = text(automation("Nightly check", "full"));
    const preview = await call("/automations/import/link", { url });
    expect(preview.status).toBe(200);
    const { source, items } = AutomationImportLinkResponse.parse(preview.body);
    expect(source.files?.map((f) => f.name)).toEqual(["nightly.md"]);
    expect(items).toMatchObject([{ fileName: "nightly.md", error: null, fullPermissions: true }]);
    expect(items[0]?.automation?.name).toBe("Nightly check");

    // The publisher swaps the file after the preview: the import still creates what was previewed.
    routes[url] = text(automation("Something else"));
    const imported = await call("/automations/import", { source, select: ["nightly.md"] });
    expect(imported.status).toBe(201);
    const { created, failed } = ImportAutomationsResponse.parse(imported.body);
    expect(failed).toEqual([]);
    expect(created.map((c) => c.automation)).toMatchObject([
      { name: "Nightly check", enabled: false, createdBy: "import" },
    ]);
    expect(download.calls.filter((c) => c.url === url)).toHaveLength(1);
  });

  it("answers bad links with the error's status and code", async () => {
    const http = await call("/automations/import/link", { url: "http://example.com/a.md" });
    expect(http).toMatchObject({ status: 400, body: { error: { code: "invalid_link" } } });
    const missing = await call("/automations/import/link", { url: "https://example.com/gone.md" });
    expect(missing).toMatchObject({ status: 502, body: { error: { code: "link_fetch_failed" } } });
    expect((await call("/automations/import/link", { url: "" })).status).toBe(400);
  });
});
