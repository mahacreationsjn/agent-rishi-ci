/**
 * Small Markdown and number helpers for the transcript export (§13). Pure: text in, text out.
 */

/** Text on one line: runs of whitespace (newlines included) become one space. */
export function oneLine(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

/** `text` cut to `max` characters with an ellipsis. */
export function clip(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1).trimEnd()}…` : text;
}

/** The longest run of backticks in `text`. */
function longestBacktickRun(text: string): number {
  let longest = 0;
  for (const run of text.match(/`+/g) ?? []) longest = Math.max(longest, run.length);
  return longest;
}

/**
 * `text` as inline code that its own backticks can't close: the delimiter is one backtick longer
 * than the longest run inside, padded with spaces when the text starts or ends with one.
 */
export function inlineCode(text: string): string {
  const body = oneLine(text) || " ";
  const fence = "`".repeat(longestBacktickRun(body) + 1);
  const pad = body.startsWith("`") || body.endsWith("`") ? " " : "";
  return `${fence}${pad}${body}${pad}${fence}`;
}

/**
 * `text` in a fenced code block that its own backticks can't close: the fence is at least three
 * backticks and longer than the longest run inside.
 */
export function fenced(text: string, lang = ""): string {
  const fence = "`".repeat(Math.max(3, longestBacktickRun(text) + 1));
  return `${fence}${lang}\n${text.replace(/\n+$/, "")}\n${fence}`;
}

/** Every line of `text` prefixed with `prefix` (blank lines keep the prefix without trailing space). */
export function prefixLines(text: string, prefix: string): string {
  return text
    .split("\n")
    .map((line) => (line ? `${prefix}${line}` : prefix.trimEnd()))
    .join("\n");
}

/** `text` as a Markdown blockquote. */
export function quote(text: string): string {
  return prefixLines(text, "> ");
}

/** A fence line (after indentation or quote markers): its run of backticks or tildes. */
const FENCE = /^[ \t>]*(`{3,}|~{3,})/;

/**
 * `text` with literal `<details>` and `<summary>` tags (opening or closing) escaped as `&lt;…`,
 * so a message can't open or close the export's folded blocks. Code shows tags as written, so
 * fenced blocks and inline code are left alone.
 */
export function escapeFolds(text: string): string {
  if (!/<\/?(?:details|summary)\b/i.test(text)) return text;
  let fence: string | null = null;
  return text
    .split("\n")
    .map((line) => {
      const marker = FENCE.exec(line)?.[1];
      if (fence) {
        if (marker && marker[0] === fence[0] && marker.length >= fence.length) fence = null;
        return line;
      }
      if (marker) {
        fence = marker;
        return line;
      }
      // An inline code span runs from a run of backticks to the next run of the same length
      // (at most 16, so a long run of backticks is read in steps, not again from each one).
      return line.replace(/(`{1,16}).*?\1|<(\/?(?:details|summary))\b/gi, (match, ticks, tag) =>
        ticks ? match : `&lt;${tag}`,
      );
    })
    .join("\n");
}

/** "$3.20", "$0.042", "$1,284"; estimates read "≈ $3.20" (as the app shows them). */
export function usd(n: number, estimated = false): string {
  const digits = n === 0 ? 2 : n < 0.1 ? 3 : n < 1000 ? 2 : 0;
  const text = new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  }).format(n);
  return estimated && n > 0 ? `≈ ${text}` : text;
}

/** "12.4M", "860k", "42". */
export function tokenCount(n: number): string {
  if (n >= 1e9) return `${(n / 1e9).toFixed(1)}B`;
  if (n >= 1e6) return `${(n / 1e6).toFixed(n >= 1e7 ? 0 : 1)}M`;
  if (n >= 1e3) return `${Math.round(n / 1e3)}k`;
  return String(Math.round(n));
}

/** "2026-11-14 10:02 UTC" for an ISO timestamp (the input when it isn't one). */
export function utcTime(ts: string): string {
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return ts;
  return `${d.toISOString().slice(0, 16).replace("T", " ")} UTC`;
}

/** "45s", "3m 20s", "1h 5m". */
export function duration(ms: number): string {
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${s % 60}s`;
  return `${Math.floor(m / 60)}h ${m % 60}m`;
}

/** Lowercase ASCII words joined by hyphens, at most `max` characters; empty when none. */
export function slug(text: string, max = 60): string {
  return text
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+/, "")
    .slice(0, max)
    .replace(/-+$/, "");
}
