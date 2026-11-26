import type { ErrorKind } from "@agent-rishi/contracts";
import type { OcError } from "./protocol";

const CONTEXT = /context (window|length)|too long|maximum context|prompt is too long|token limit/i;
const QUOTA = /quota|usage limit|insufficient|billing|credit|exceeded your/i;
const TRANSIENT =
  /overload|unavailable|timeout|timed out|econnreset|connection|network|socket|stream|temporar/i;
/** OpenCode's error type when it has no usable model for the session. */
const NO_ROUTE = "provider.no-route";
/** OpenCode's plain "the session's folder doesn't list this model" message. */
const MODEL_UNAVAILABLE = /^Model unavailable: \S+$/;
/** An HTTP status OpenCode gave only in the message: "Request failed: 401", "HTTP 403". */
const STATUS_IN_MESSAGE = /\b(?:request failed|status(?: code)?|http)\W{0,3}([1-5]\d\d)\b/i;

/**
 * Classify a failed OpenCode turn (§7.3 `ErrorInfo.kind`) from its structured error: the HTTP
 * status of the model call when there was one (in its own field, or only in the message), its
 * type and its message. `retryAt` is set for a usage limit when OpenCode said how long to wait.
 */
export function classifyOpenCodeError(
  error: OcError | undefined,
  now = Date.now(),
): { kind: ErrorKind; retryAt?: string } {
  if (!error) return { kind: "fatal" };
  // A model, variant or provider OpenCode can't use ("Model unavailable: x/y"): config, not load.
  if (error.type === NO_ROUTE) return { kind: "fatal" };
  const status = error.status ?? Number(STATUS_IN_MESSAGE.exec(error.message)?.[1] ?? 0);
  const text = `${error.type} ${error.message}`;
  if (status === 401 || status === 403 || /\bauth|unauthori[sz]ed|api key|credential/i.test(text)) {
    return { kind: "auth" };
  }
  if (CONTEXT.test(text)) return { kind: "context_full" };
  const retryAt =
    typeof error.retryAfterMs === "number" && error.retryAfterMs > 0
      ? new Date(now + error.retryAfterMs).toISOString()
      : undefined;
  if (status === 429 && QUOTA.test(text)) {
    return { kind: "usage_limit", ...(retryAt ? { retryAt } : {}) };
  }
  if (status === 429 || status >= 500 || TRANSIENT.test(text)) return { kind: "transient" };
  return { kind: "fatal" };
}

/** How an Agent Rishi turn on OpenCode ended. */
export type TurnOutcome =
  | { type: "completed" }
  | { type: "interrupted"; reason?: "user" | "provider" | "runner_restart" }
  | {
      type: "failed";
      message: string;
      code?: string;
      detail?: string;
      kind?: ErrorKind;
      retryAt?: string;
    };

/**
 * An OpenCode error as a failed turn outcome. "Model unavailable" says where the model's
 * provider must be set: the session sees the user's global config and the project's own (#643).
 */
export function failure(error: OcError | undefined): TurnOutcome {
  const { kind, retryAt } = classifyOpenCodeError(error);
  const message = error?.message || "OpenCode turn failed";
  return {
    type: "failed",
    code: error?.type ? `opencode_${error.type.replace(/[^a-z0-9]+/gi, "_")}` : "turn_failed",
    message:
      error?.type === NO_ROUTE && MODEL_UNAVAILABLE.test(message)
        ? `${message}. OpenCode doesn't list it for this session: set its provider in your global OpenCode config or in the project's opencode.json (a file that isn't valid JSON is left out), then use Refresh models in the model picker`
        : message,
    kind,
    ...(retryAt ? { retryAt } : {}),
  };
}
