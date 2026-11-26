import { isIP } from "node:net";
import {
  type AutomationImportFile,
  AUTOMATION_IMPORT_LIMITS as LIMITS,
} from "@agent-rishi/contracts";
import { z } from "zod";
import { isPrivateAddressError, isPublicAddress, publicFetch } from "../../network/public-fetch";
import { badRequest, errorMessage, ServiceError } from "../errors";
import { unzipMarkdownBytes } from "./import";

/**
 * Importing automations from a link (§10 Sharing): an https `.md` or `.zip` file, a GitHub
 * file page (downloaded from its raw address) or a gist (read through GitHub's API). It is a
 * download the user starts: the server sends the request and nothing else (no cookies,
 * tokens or GitHub credentials), never logs or stores the link, and reaches only the public
 * internet (never this computer or a private network, by link, redirect or DNS answer).
 */

/** Bytes a downloaded file may have: the zip limit (one Markdown file is far smaller). */
const MAX_FILE_BYTES = LIMITS.maxZipBytes;
/** Bytes of a gist from GitHub's API: its files' text, escaped, plus metadata. */
const MAX_GIST_BYTES = 4 * 1024 * 1024;
const WORKING_LINKS = "Use an https link to a .md or .zip file, a GitHub file or a gist";
const ZIP_SIGNATURE = [0x50, 0x4b, 0x03, 0x04];

const invalidLink = (why: string) => badRequest(`${why}. ${WORKING_LINKS}.`, "invalid_link");
const tooLarge = (message: string) => new ServiceError(413, "import_too_large", message);
const fetchFailed = (message: string) => new ServiceError(502, "link_fetch_failed", message);

const privateLink = (lead: string) =>
  invalidLink(`${lead} this computer or a private network, and only public links can be imported`);

/**
 * Refuse a link to this computer or a private network by its name (`localhost`) or address.
 * Names that resolve there are refused when connecting (`publicLookup`).
 */
function refusePrivate(url: URL, lead: string): void {
  const host = url.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  const local = host === "localhost" || host.endsWith(".localhost");
  if (local || (isIP(host) !== 0 && !isPublicAddress(host))) throw privateLink(lead);
}

/** What a link downloads: one file (Markdown or a zip), or a gist through GitHub's API. */
export type ImportLinkPlan =
  | { kind: "file"; url: URL }
  | { kind: "gist"; id: string; revision?: string };

/** Plan a link's download. Throws 400 `invalid_link` for anything but an https file or gist. */
export function planImportLink(link: string): ImportLinkPlan {
  let url: URL;
  try {
    url = new URL(link.trim());
  } catch {
    throw invalidLink("That isn't a link");
  }
  if (url.protocol !== "https:") throw invalidLink("Only https links can be imported");
  if (url.username || url.password) throw invalidLink("Links with a password can't be imported");
  refusePrivate(url, "That link points to");
  url.hash = "";
  const host = url.hostname.toLowerCase();
  const parts = url.pathname.split("/").filter(Boolean);
  if (host === "github.com" || host === "www.github.com") {
    const [owner, repo, kind, ...rest] = parts;
    // "Download ZIP" (/archive/...) and release assets (/releases/download/...) are files.
    if (kind === "archive" || (kind === "releases" && rest[0] === "download")) {
      return { kind: "file", url };
    }
    // github.com/<owner>/<repo>/blob/<ref>/<path>: the same file from its raw address.
    if (!owner || !repo || (kind !== "blob" && kind !== "raw") || rest.length < 2) {
      throw invalidLink("That GitHub page isn't a file");
    }
    const raw = [owner, repo, ...rest].join("/");
    return { kind: "file", url: new URL(`https://raw.githubusercontent.com/${raw}`) };
  }
  if (host === "gist.github.com") {
    // gist.github.com/<id>, /<user>/<id> or /<user>/<id>/<revision>; /<user>/<id>/raw/... is a file.
    if (parts[2] === "raw") return { kind: "file", url };
    const id = parts.length === 1 ? parts[0] : parts[1];
    const revision = parts[2];
    if (
      !id ||
      !/^[0-9a-f]{1,64}$/i.test(id) ||
      parts.length > 3 ||
      (revision !== undefined && !/^[0-9a-f]{40}$/i.test(revision))
    ) {
      throw invalidLink("That gist page isn't a gist");
    }
    return revision ? { kind: "gist", id, revision } : { kind: "gist", id };
  }
  return { kind: "file", url };
}

/** Why a request got no answer: a timeout, or the network error's own cause. */
function unreachable(url: URL, error: unknown, signal: AbortSignal): ServiceError {
  if (signal.aborted) {
    return fetchFailed(`${url.host} didn't answer within ${LIMITS.linkTimeoutMs / 1000} seconds`);
  }
  const cause = error instanceof Error && error.cause instanceof Error ? error.cause : error;
  return fetchFailed(`Couldn't reach ${url.host}: ${errorMessage(cause)}`);
}

/** An answer other than 2xx, named by host and status. */
function answered(url: URL, res: Response): ServiceError {
  if (
    url.host === "api.github.com" &&
    (res.status === 403 || res.status === 429) &&
    res.headers.get("x-ratelimit-remaining") === "0"
  ) {
    return fetchFailed("GitHub's limit for anonymous requests was reached; try again later");
  }
  const github = url.host === "api.github.com" || url.host.endsWith(".githubusercontent.com");
  const hint = github && res.status === 404 ? " (only public files and gists can be imported)" : "";
  return fetchFailed(`${url.host} answered ${res.status} ${res.statusText}`.trim() + hint);
}

/** The body, refused past `maxBytes` (by its declared length first, then as it arrives). */
async function readCapped(res: Response, maxBytes: number, url: URL, signal: AbortSignal) {
  const tooBig = () => tooLarge(`The download is larger than ${maxBytes / 1024} KB`);
  if (Number(res.headers.get("content-length") ?? 0) > maxBytes) {
    await res.body?.cancel();
    throw tooBig();
  }
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for await (const chunk of res.body ?? []) {
      total += chunk.length;
      if (total > maxBytes) throw tooBig();
      chunks.push(chunk);
    }
  } catch (error) {
    if (error instanceof ServiceError) throw error;
    throw unreachable(url, error, signal);
  }
  return new Uint8Array(Buffer.concat(chunks));
}

interface Downloaded {
  bytes: Uint8Array;
  contentType: string;
  /** Where the file came from, after redirects. */
  url: URL;
}

/**
 * GET a link with no credentials (only `user-agent`, `accept` and, for GitHub's API, its
 * version header), following at most `maxLinkRedirects` redirects by hand so each one must
 * stay on https.
 */
async function download(
  start: URL,
  doFetch: typeof fetch,
  maxBytes: number,
  headers: Record<string, string>,
): Promise<Downloaded> {
  const signal = AbortSignal.timeout(LIMITS.linkTimeoutMs);
  let url = start;
  for (let redirects = 0; ; redirects++) {
    let res: Response;
    try {
      res = await doFetch(url, {
        redirect: "manual",
        signal,
        headers: { "user-agent": "agent-rishi", ...headers },
      });
    } catch (error) {
      if (isPrivateAddressError(error)) throw privateLink(`${url.host} leads to`);
      throw unreachable(url, error, signal);
    }
    const location = res.status >= 300 && res.status < 400 ? res.headers.get("location") : null;
    if (!location) {
      if (!res.ok) {
        await res.body?.cancel();
        throw answered(url, res);
      }
      const bytes = await readCapped(res, maxBytes, url, signal);
      return { bytes, contentType: res.headers.get("content-type") ?? "", url };
    }
    await res.body?.cancel();
    if (redirects >= LIMITS.maxLinkRedirects) {
      throw fetchFailed(`${start.host} redirected more than ${LIMITS.maxLinkRedirects} times`);
    }
    let next: URL;
    try {
      next = new URL(location, url);
    } catch {
      throw fetchFailed(`${url.host} redirected to something that isn't a link`);
    }
    if (next.protocol !== "https:") {
      throw invalidLink(`${url.host} redirected to a link that isn't https`);
    }
    refusePrivate(next, `${url.host} redirected to`);
    url = next;
  }
}

/** A downloaded file's name: its last path segment as a `.md` file, at most 200 characters. */
function markdownName(url: URL): string {
  const last = url.pathname.split("/").filter(Boolean).pop() ?? "";
  let name = last;
  try {
    name = decodeURIComponent(last);
  } catch {
    // Keep the encoded segment.
  }
  const stem =
    name
      .trim()
      .replace(/\.(md|markdown|txt)$/i, "")
      .slice(0, 200) || "automation";
  return `${stem}.md`;
}

/** One file: a zip (by its signature) is unpacked, a web page refused, the rest is Markdown. */
async function downloadFile(url: URL, doFetch: typeof fetch): Promise<AutomationImportFile[]> {
  const got = await download(url, doFetch, MAX_FILE_BYTES, {
    accept: "text/markdown, text/plain;q=0.9, application/zip;q=0.9, */*;q=0.5",
  });
  if (ZIP_SIGNATURE.every((b, i) => got.bytes[i] === b)) return unzipMarkdownBytes(got.bytes);
  if (/\.zip$/i.test(got.url.pathname)) {
    throw badRequest(`${got.url.host} sent something that isn't a zip`, "invalid_zip");
  }
  const content = new TextDecoder().decode(got.bytes);
  if (
    /^\s*(text\/html|application\/xhtml\+xml)\b/i.test(got.contentType) ||
    /^\s*<(!doctype html|html[\s>])/i.test(content.slice(0, 512))
  ) {
    throw badRequest(
      "That link opens a web page, not a file: use the link to the raw file",
      "link_not_a_file",
    );
  }
  return [{ name: markdownName(got.url), content }];
}

/** The part of GitHub's gist API answer an import reads. */
const GistAnswer = z.object({
  files: z.record(
    z.string(),
    z
      .object({
        filename: z.string(),
        content: z.string().optional(),
        truncated: z.boolean().optional(),
      })
      .nullable(),
  ),
});

/** A gist's `.md` files (other files are ignored, like a zip's). */
async function downloadGist(
  plan: Extract<ImportLinkPlan, { kind: "gist" }>,
  doFetch: typeof fetch,
): Promise<AutomationImportFile[]> {
  const path = plan.revision ? `${plan.id}/${plan.revision}` : plan.id;
  const got = await download(
    new URL(`https://api.github.com/gists/${path}`),
    doFetch,
    MAX_GIST_BYTES,
    {
      accept: "application/vnd.github+json",
      "x-github-api-version": "2022-11-28",
    },
  );
  let gist: z.infer<typeof GistAnswer>;
  try {
    gist = GistAnswer.parse(JSON.parse(new TextDecoder().decode(got.bytes)));
  } catch {
    throw fetchFailed("GitHub sent a gist Agent Rishi couldn't read");
  }
  return Object.values(gist.files).flatMap((file) => {
    if (!file || !/\.md$/i.test(file.filename)) return [];
    // GitHub leaves out the text of files over 1 MB, far past the import limit.
    if (file.truncated || file.content === undefined) {
      throw tooLarge(`${file.filename} is larger than ${LIMITS.maxFileChars / 1024} KB`);
    }
    return [{ name: file.filename.slice(-255), content: file.content }];
  });
}

export interface ImportLinkOptions {
  /** The downloader (tests script it); `publicFetch`, which reaches only public addresses, otherwise. */
  fetch?: typeof fetch;
}

/**
 * Download the automation files a link points to, once. Each file is checked against the
 * per-file size limit here; the count and total are `collectImportFiles`' job.
 */
export async function resolveImportLink(
  link: string,
  opts: ImportLinkOptions = {},
): Promise<AutomationImportFile[]> {
  const doFetch = opts.fetch ?? publicFetch;
  const plan = planImportLink(link);
  const files =
    plan.kind === "gist"
      ? await downloadGist(plan, doFetch)
      : await downloadFile(plan.url, doFetch);
  for (const file of files) {
    if (file.content.length > LIMITS.maxFileChars) {
      throw tooLarge(`${file.name} is larger than ${LIMITS.maxFileChars / 1024} KB`);
    }
  }
  return files;
}
