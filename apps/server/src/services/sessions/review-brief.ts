import type { ItemOf, Session } from "@agent-rishi/contracts";
import { UNTRUSTED_INPUT } from "../factory/prompts";
import {
  BRIEF_MAX,
  clip,
  files,
  laterRequests,
  oneLine,
  quote,
  quotesUntrustedInput,
  task,
} from "./handoff-brief";
import type { FileEditCall } from "./repo";

const CLAIMS_MAX = 3_000;
/**
 * Read-only sessions run only commands that read, each on its own (§11.2): the allowlist
 * refuses command substitution, redirection and variable expansion.
 */
const READ_ONLY_SHELL =
  "Run plain commands, one at a time: this read-only session refuses command substitution (`$(…)`), redirection to files and variable expansion, and anything that edits, installs or commits.";

/** What a review's brief is written from: the session under review and its transcript. */
export interface ReviewSource {
  /** The session whose changes are reviewed. */
  session: Session;
  /** Display name of its provider. */
  providerName: string;
  /** The branch its change is measured against (its base branch, else the project's default). */
  baseBranch: string;
  /** Whether the reviewer's worktree got the source's uncommitted changes (it had a checkpoint). */
  restored: boolean;
  /** The source's root-thread user messages, oldest first. */
  requests: ItemOf<"user_message">[];
  /** Its latest root-thread assistant message, if any: what it says it did. */
  lastReply: string | null;
  /** Every file edit of the session, oldest first. */
  edits: FileEditCall[];
  /** What the user wants the reviewer to look at most closely. */
  focus?: string;
}

/**
 * The first message of a review session (§9): an independent, read-only review of another
 * session's changes. Sections in order: whose work it reviews and where the code is, the task,
 * later requests, what the author says it did, the files it edited, the user's focus, how to
 * review and what to report. The intro and the closing (how to review, the report) are always
 * whole; the sections between are shortened when the brief would pass `BRIEF_MAX`.
 *
 * Like a handoff's brief it is Agent Rishi's message, so it never relays anyone else's words as its
 * own: other senders are quoted under who sent them, and work on an issue or started by someone
 * other than the user keeps the untrusted-input rule in the intro.
 */
export function buildReviewBrief(src: ReviewSource): string {
  const head = intro(src);
  const tail = [focus(src), howToReview(src), report()].filter(Boolean).join("\n\n");
  const body = [task(src), laterRequests(src), claims(src), files(src)]
    .filter((s): s is string => s !== null)
    .join("\n\n");
  const room = BRIEF_MAX - head.length - tail.length - 4;
  const fitted =
    body.length <= room ? body : `${body.slice(0, Math.max(0, room - 30))}\n\n…(brief shortened)`;
  return [head, fitted, tail].filter(Boolean).join("\n\n");
}

function intro(src: ReviewSource): string {
  const { session: s, providerName } = src;
  const title = s.title ?? s.purpose;
  const model = s.model ? ` · ${s.model}` : "";
  const changes = src.restored ? ", with the uncommitted changes it had restored" : "";
  const folder = s.worktreePath
    ? ` Its own folder is \`${s.worktreePath}\`: don't work there.`
    : "";
  const lines = [
    `You are an independent reviewer. Review the changes another Agent Rishi session made, "${oneLine(title)}" (${providerName}${model}). You didn't write this code and you don't have its conversation: judge the change on its own merits, not on what the author says about it.`,
    s.branch
      ? `Its code is in this worktree: your branch starts from its branch \`${s.branch}\`${changes}, and its base branch is \`${src.baseBranch}\`.${folder}`
      : "",
    s.issue
      ? `Issue: #${s.issue.number}${s.issue.title ? ` ${oneLine(s.issue.title)}` : ""} (${s.issue.url})`
      : "",
    s.pr ? `Its pull request: #${s.pr.number} (${s.pr.url}).` : "",
    "This session is read-only: you can read files and run checks, but don't edit files, commit, push or open a pull request.",
    quotesUntrustedInput(src) ? UNTRUSTED_INPUT : "",
  ];
  return lines.filter(Boolean).join("\n");
}

/** The author's last reply, quoted as claims to check, never as facts. */
function claims(src: ReviewSource): string | null {
  const reply = src.lastReply?.trim();
  if (!reply) return null;
  return `## What the author says it did (check it, don't trust it)\n\n${quote(clip(reply, CLAIMS_MAX))}`;
}

function focus(src: ReviewSource): string | null {
  const text = src.focus?.trim();
  return text ? `## What to focus on (from the user)\n\n${text}` : null;
}

function howToReview(src: ReviewSource): string {
  const base = src.baseBranch;
  return [
    "## How to review",
    "",
    `- Read the whole change since it left \`${base}\`: \`git log --oneline origin/${base}..HEAD\` lists its commits and \`git diff origin/${base}...HEAD\` shows them, \`git diff HEAD\` shows its uncommitted edits, and \`git status\` lists new files, which \`git diff\` leaves out: read those too. Use \`${base}\` instead of \`origin/${base}\` when the repository has no \`origin\`.`,
    "- Read the code around the change, not only the diff.",
    "- Judge: does it do what was asked, and nothing it shouldn't? Is it correct (edge cases, error handling, concurrency, data loss)? Are there tests that prove the behaviour, and do they pass? Does it follow the project's conventions (its AGENTS.md, CLAUDE.md or README)? Any security problems (injection, secrets, unsafe input, risky dependencies)?",
    "- Run the project's checks (tests, lint, type-check) where you can, in the foreground, waiting for them in the same turn, and non-interactively: nothing can answer a prompt in your shell. When a check can't run here, say so instead of guessing its result. You don't need the network.",
    `- ${READ_ONLY_SHELL}`,
  ].join("\n");
}

function report(): string {
  return [
    "## Your review",
    "",
    "End with your review as your final reply:",
    "1. The verdict on the first line: **Approve** or **Request changes**.",
    "2. The findings, most severe first. For each: `path:line`, what is wrong, a concrete case where it fails, and whether it blocks (must be fixed before merging) or can wait.",
    "3. What you checked: the commands you ran and what they showed.",
    "",
    "Then call `finish` with the verdict and a one-line summary.",
  ].join("\n");
}
