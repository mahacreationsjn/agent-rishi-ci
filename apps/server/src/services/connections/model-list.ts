import type { ApiProvider } from "@agent-rishi/contracts";
import { hideValues } from "../vault/redaction";

/**
 * Listing a connection's models (`docs/foundation.md` §4.2): each provider's models endpoint,
 * which costs no tokens. Model names come only from here, or from the owner by hand; none is
 * written into Agent Rishi.
 *
 * A key leaves only in the request's own header, to the address the owner set: redirects are
 * not followed, answers are read up to a size limit, and no error text is passed on as it came
 * (a transport error may quote a header), so nothing a server or the network says can carry a
 * key into a message, the database or the UI.
 */

/** Where each provider's API lives unless the connection says otherwise. */
export const DEFAULT_BASE_URLS: Record<Exclude<ApiProvider, "openai-compatible">, string> = {
  anthropic: "https://api.anthropic.com/v1",
  openai: "https://api.openai.com/v1",
  gemini: "https://generativelanguage.googleapis.com/v1beta",
  xai: "https://api.x.ai/v1",
  // V2 is Sarvam AI's OpenAI-compatible API, with `GET /v2/models`; V1 lists nothing.
  "sarvam-ai": "https://api.sarvam.ai/v2",
};

export function baseUrlFor(provider: ApiProvider, baseUrl: string | null): string | null {
  const base = baseUrl ?? (provider === "openai-compatible" ? null : DEFAULT_BASE_URLS[provider]);
  return base ? base.replace(/\/+$/, "") : null;
}

/**
 * Whether plain `http` may carry a key to this address: only to this computer or a private
 * network (a model server on the LAN or the tailnet), never across the internet.
 */
export function privateAddress(url: URL): boolean {
  const host = url.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local")) return true;
  if (host === "::1" || /^f[cd][0-9a-f]{2}:/.test(host) || host.startsWith("fe80:")) return true;
  const ip = host.split(".").map(Number);
  if (ip.length !== 4 || ip.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return false;
  const [a = -1, b = -1] = ip;
  return (
    a === 127 ||
    a === 10 ||
    (a === 192 && b === 168) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 100 && b >= 64 && b <= 127)
  );
}

/**
 * Why a listing failed. `auth`: the key was refused. `unsupported`: the server has no models
 * endpoint. `failed`: anything else (unreachable, an error, an answer that isn't a model list).
 */
export class ModelListError extends Error {
  constructor(
    readonly reason: "auth" | "unsupported" | "failed",
    message: string,
  ) {
    super(message);
    this.name = "ModelListError";
  }
}

export interface ListedModel {
  id: string;
  name: string | null;
}

export interface ListModelsOptions {
  provider: ApiProvider;
  baseUrl: string;
  key: string | null;
  fetch?: typeof fetch;
  timeoutMs?: number;
  /** Called before each request; listing stops if it returns false (the grant was removed). */
  stillAllowed?: () => boolean;
}

const MAX_PAGES = 10;
/** As many models as a connection keeps; providers list far fewer. */
export const MAX_MODELS = 2000;
/** The largest answer read, in bytes. */
export const MAX_BODY_BYTES = 4 * 1024 * 1024;
/** Longest model id and name kept (the contract's limit). */
const MAX_ID = 200;

type Json = Record<string, unknown>;

/** The models a connection offers, at most `MAX_MODELS`. */
export async function listModels(opts: ListModelsOptions): Promise<ListedModel[]> {
  if (opts.key !== null && !/^[\x21-\x7e]+$/.test(opts.key)) {
    throw new ModelListError(
      "failed",
      "The key has spaces or characters a request header can't carry. Enter it again in the Vault.",
    );
  }
  const models =
    opts.provider === "anthropic"
      ? await listAnthropic(opts)
      : opts.provider === "gemini"
        ? await listGemini(opts)
        : await listOpenAiStyle(opts);
  return clean(models, opts.key);
}

/**
 * Models as they may be kept and shown: within the contract's lengths, each id once, and none
 * that repeats the key (a server could echo it back).
 */
function clean(models: ListedModel[], key: string | null): ListedModel[] {
  const seen = new Set<string>();
  const out: ListedModel[] = [];
  for (const m of models) {
    if (m.id.length > MAX_ID || seen.has(m.id) || (key && m.id.includes(key))) continue;
    seen.add(m.id);
    const name = m.name && key ? hideValues(m.name, [key]) : m.name;
    out.push({ id: m.id, name: name ? name.slice(0, MAX_ID) : null });
    if (out.length >= MAX_MODELS) break;
  }
  return out;
}

/** Why a request didn't get an answer, in fixed words. */
function transportReason(error: unknown): string {
  if (error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError")) {
    return "it didn't answer in time";
  }
  const code = (error as { cause?: { code?: unknown } } | null)?.cause?.code;
  return typeof code === "string" && /^[A-Z_]{3,40}$/.test(code) ? code : "the request failed";
}

/** The answer's text, or null once it passes `MAX_BODY_BYTES`. */
async function readCapped(res: Response): Promise<string | null> {
  if (!res.body) return "";
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > MAX_BODY_BYTES) {
      await reader.cancel().catch(() => {});
      return null;
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString("utf8");
}

async function getJson(opts: ListModelsOptions, url: URL, headers: Record<string, string>) {
  const host = url.host;
  if (opts.stillAllowed && !opts.stillAllowed()) {
    throw new ModelListError("failed", "Its key stopped being granted during the check");
  }
  let res: Response;
  try {
    res = await (opts.fetch ?? fetch)(url, {
      headers: { accept: "application/json", ...headers },
      redirect: "manual",
      signal: AbortSignal.timeout(opts.timeoutMs ?? 15_000),
    });
  } catch (error) {
    throw new ModelListError("failed", `Couldn't reach ${host}: ${transportReason(error)}`);
  }
  if (res.status >= 300 && res.status < 400) {
    throw new ModelListError(
      "failed",
      `${host} sent the request elsewhere (HTTP ${res.status}); Agent Rishi doesn't follow it with a key. Set the base URL it points to.`,
    );
  }
  if (res.status === 401 || res.status === 403) {
    throw new ModelListError("auth", `${host} refused the key (HTTP ${res.status})`);
  }
  if (res.status === 404 || res.status === 405) {
    throw new ModelListError("unsupported", `${host} doesn't list its models at this address`);
  }
  if (!res.ok) throw new ModelListError("failed", `${host} answered HTTP ${res.status}`);
  const body = await readCapped(res);
  if (body === null) throw new ModelListError("failed", `${host} answered with too much data`);
  try {
    return JSON.parse(body) as Json;
  } catch {
    throw new ModelListError("failed", `${host} didn't answer with a model list`);
  }
}

/** `base` + `/models`, with the query set through the URL, never by joining strings. */
function modelsUrl(base: string, query: Record<string, string | null> = {}): URL {
  const url = new URL(base);
  url.pathname = `${url.pathname.replace(/\/+$/, "")}/models`;
  for (const [k, v] of Object.entries(query)) if (v !== null) url.searchParams.set(k, v);
  return url;
}

function notAList(url: URL): ModelListError {
  return new ModelListError("failed", `${url.host} didn't answer with a model list`);
}

const text = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : null);

/** `GET /models` with `x-api-key`, paged with `after_id`. */
async function listAnthropic(opts: ListModelsOptions): Promise<ListedModel[]> {
  const out: ListedModel[] = [];
  let after: string | null = null;
  for (let page = 0; page < MAX_PAGES && out.length < MAX_MODELS; page++) {
    const url = modelsUrl(opts.baseUrl, { limit: "1000", after_id: after });
    const body = await getJson(opts, url, {
      "x-api-key": opts.key ?? "",
      "anthropic-version": "2023-06-01",
    });
    if (!Array.isArray(body.data)) throw notAList(url);
    for (const m of body.data as Json[]) {
      const id = text(m.id);
      if (id) out.push({ id, name: text(m.display_name) });
    }
    after = body.has_more === true ? text(body.last_id) : null;
    if (!after) break;
  }
  return out;
}

/** `GET /models` with `x-goog-api-key`, paged; only models that generate content. */
async function listGemini(opts: ListModelsOptions): Promise<ListedModel[]> {
  const out: ListedModel[] = [];
  let token: string | null = null;
  for (let page = 0; page < MAX_PAGES && out.length < MAX_MODELS; page++) {
    const url = modelsUrl(opts.baseUrl, { pageSize: "1000", pageToken: token });
    const body = await getJson(opts, url, { "x-goog-api-key": opts.key ?? "" });
    if (!Array.isArray(body.models)) throw notAList(url);
    for (const m of body.models as Json[]) {
      const id = text(m.name)?.replace(/^models\//, "");
      const methods = m.supportedGenerationMethods;
      const generates = !Array.isArray(methods) || methods.includes("generateContent");
      if (id && generates) out.push({ id, name: text(m.displayName) });
    }
    token = text(body.nextPageToken);
    if (!token) break;
  }
  return out;
}

/** `GET /models` in the OpenAI style (OpenAI, xAI, Sarvam AI, compatible servers). */
async function listOpenAiStyle(opts: ListModelsOptions): Promise<ListedModel[]> {
  const url = modelsUrl(opts.baseUrl);
  const headers: Record<string, string> = {};
  if (opts.key) {
    // Sarvam AI's own header, which its models endpoint was seen to answer; others take a bearer key.
    if (opts.provider === "sarvam-ai") headers["api-subscription-key"] = opts.key;
    else headers.authorization = `Bearer ${opts.key}`;
  }
  const body = await getJson(opts, url, headers);
  // Most servers answer `{ data: [...] }`; a few answer the array itself.
  const list = Array.isArray(body) ? body : body.data;
  if (!Array.isArray(list)) throw notAList(url);
  return (list as Json[]).flatMap((m) => {
    const id = text(m.id);
    return id ? [{ id, name: text(m.name) }] : [];
  });
}
