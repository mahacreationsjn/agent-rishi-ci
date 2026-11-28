import { type NewEvent, REDACTED } from "@agent-rishi/contracts";

/**
 * Keeping Vault values out of stored text (`docs/foundation.md` §3.4). The event log is
 * append-only, so a value that reached it could never be taken out again: every event is
 * redacted on its way in (`EventStore`), before it is stored, projected or sent to the UI.
 */

/**
 * The shortest piece of a value hidden at the edge of a streamed chunk. A value split across
 * chunks leaves at most this many characters less one in any chunk.
 */
export const FRAGMENT_MIN = 4;

/** Values longest first, so one that contains another is hidden whole. */
export function sortValues(values: Iterable<string>): string[] {
  return [...new Set(values)].filter((v) => v.length > 0).sort((a, b) => b.length - a.length);
}

/** `text` with every whole value replaced by `[redacted]`. */
export function hideValues(text: string, values: readonly string[]): string {
  let out = text;
  for (const value of values) if (out.includes(value)) out = out.split(value).join(REDACTED);
  return out;
}

/** Where `text` ends with the start of `value` (at least `FRAGMENT_MIN` long), or -1. */
function tailStart(text: string, value: string): number {
  const head = value.slice(0, FRAGMENT_MIN);
  const from = Math.max(0, text.length - (value.length - 1));
  for (let at = text.indexOf(head, from); at !== -1; at = text.indexOf(head, at + 1)) {
    if (value.startsWith(text.slice(at))) return at;
  }
  return -1;
}

/** How long a start of `text` is that ends `value` (at least `FRAGMENT_MIN`), or 0. */
function headLength(text: string, value: string): number {
  const tail = value.slice(-FRAGMENT_MIN);
  const limit = Math.min(text.length, value.length - 1);
  let found = 0;
  for (let at = text.indexOf(tail); at !== -1 && at + FRAGMENT_MIN <= limit; ) {
    const end = at + FRAGMENT_MIN;
    if (value.endsWith(text.slice(0, end))) found = end;
    at = text.indexOf(tail, at + 1);
  }
  return found;
}

/**
 * Like `hideValues`, for one chunk of streamed text: a value can arrive split across chunks, so
 * a chunk that lies inside a value, ends with a value's start or starts with its end is hidden
 * there too.
 */
export function hideFragments(text: string, values: readonly string[]): string {
  let out = hideValues(text, values);
  for (const value of values) {
    if (out.length >= FRAGMENT_MIN && value.includes(out)) return REDACTED;
    const at = tailStart(out, value);
    if (at !== -1) out = out.slice(0, at) + REDACTED;
    const length = headLength(out, value);
    if (length > 0) out = REDACTED + out.slice(length);
  }
  return out;
}

/** `value` with `hide` applied to every string in it; the same object when nothing changed. */
export function redactDeep<T>(value: T, hide: (text: string) => string): T {
  if (typeof value === "string") return hide(value) as T;
  if (Array.isArray(value)) {
    let changed = false;
    const next = value.map((v) => {
      const r = redactDeep(v, hide);
      if (r !== v) changed = true;
      return r;
    });
    return (changed ? next : value) as T;
  }
  if (value !== null && typeof value === "object") {
    let changed = false;
    const next: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      const r = redactDeep(v, hide);
      if (r !== v) changed = true;
      next[k] = r;
    }
    return (changed ? next : value) as T;
  }
  return value;
}

/** One event with every known value hidden; the same event when there was none. */
export function redactEvent(event: NewEvent, values: readonly string[]): NewEvent {
  if (values.length === 0) return event;
  let payload = redactDeep(event.payload as unknown, (s) => hideValues(s, values));
  if (event.type === "agent.item.delta") {
    const { delta } = payload as { delta: Record<string, unknown> };
    const field = delta.type === "tool_input" ? "partialJson" : "text";
    const chunk = delta[field];
    if (typeof chunk === "string") {
      const hidden = hideFragments(chunk, values);
      if (hidden !== chunk) {
        payload = { ...(payload as object), delta: { ...delta, [field]: hidden } };
      }
    }
  }
  return payload === event.payload ? event : ({ ...event, payload } as NewEvent);
}
