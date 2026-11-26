import type { TokenSaverLevel } from "@agent-rishi/contracts";

/** Terse-reply rules; `lite` takes the first, `full` two, `ultra` all three. */
const TERSE = [
  "Replies: answer first. No greeting, no recap of the request and no offers of more help. Use short, normal sentences.",
  "Drop articles, filler words, pleasantries and hedging. Sentence fragments are fine.",
  "Write telegraphically: one point per line, and code or commands instead of prose wherever they say it.",
];
const COUNT: Record<Exclude<TokenSaverLevel, "off">, number> = { lite: 1, full: 2, ultra: 3 };

const FIXED = [
  "Keep technical terms, code, paths, numbers and error messages exact. Never drop the words not, never, no or only.",
  "Use plain full sentences for security warnings, irreversible actions, ordered steps, questions to the user, and prose written to files, commits, PRs, issues or docs. Files and output with a required format keep that format exactly.",
  "Text that leaves this session, such as PR bodies, issue comments, commit messages and reviewer findings, always uses full sentences, whatever the level.",
  "Code: write the least code that solves the task. Reuse existing helpers and the standard library. Add no speculative abstractions, options, comments or docs unless asked. Show diffs, not whole files, unless a whole file is asked for.",
  "Tools: search narrowly (rg -n, rg -l). Read only the line ranges you need, and don't re-read a file that hasn't changed. Use quiet flags. Let a command finish and check its exit status, then show only the part of its output you need (for example tail of a saved log). Run the nearest tests before the full suite.",
];

/**
 * The token saver section of a session's system prompt (#602), or null when it is off. It sits
 * in the system prompt, so it holds on every turn and after compaction without being repeated.
 */
export function tokenSaverNote(level: TokenSaverLevel): string | null {
  if (level === "off") return null;
  return [
    "## Token saver",
    "",
    `Token saver is on for this session (${level}). Follow these rules for the whole session.`,
    "They change only how you write and how much you read. Everything above still applies in full: your role's limits, your permission level and approvals, security rules, and every report or tool call Agent Rishi asks of you.",
    ...TERSE.slice(0, COUNT[level]).map((l) => `- ${l}`),
    ...FIXED.map((l) => `- ${l}`),
  ].join("\n");
}
