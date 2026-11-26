import {
  type ApprovalDecider,
  type ApprovalDecision,
  type Attachment,
  type FileChange,
  type HookRunOutcome,
  type Item,
  type ItemOf,
  type ItemStatus,
  type MessageSender,
  splitSender,
  type ToolCallItem,
} from "@agent-rishi/contracts";
import { relativeTo } from "./handoff-brief";
import { clip, fenced, inlineCode, oneLine, prefixLines, quote } from "./transcript-format";

/**
 * Markdown for one transcript item of the export (§13). Subagents are rendered by the builder
 * (`transcript-markdown.ts`), which recurses into their threads; reasoning, follow-up chips and
 * tool output are left out on purpose.
 */

/** What rendering an item needs besides the item. */
export interface ItemContext {
  /** The worktree (or folder) that tool paths are shown relative to. */
  root: string | null;
  /** Whose replies the thread holds: "Agent", "Project manager", "Subagent"... */
  speaker: string;
  /** Hides secrets (and counts them); text is passed through it before it's cut short. */
  redact: (text: string) => string;
}

/**
 * `text` cut to `max` characters, its secrets hidden first: a cut through a token would leave
 * a piece too short for the redactor to recognise.
 */
function cut(text: string, max: number, ctx: ItemContext): string {
  return clip(ctx.redact(text), max);
}

/** A single-line command longer than this is cut. */
const COMMAND_MAX = 300;
/** A multi-line command (a script, a heredoc) is cut at this many characters. */
const COMMAND_BLOCK_MAX = 2_000;
/** At most this many files are named on one edit line. */
const FILES_SHOWN = 20;

const SENDERS: Readonly<Record<MessageSender, string>> = {
  user: "User",
  pm: "Project manager",
  orchestrator: "Orchestrator",
  factory: "Software factory",
  automation: "Automation",
  "agent-rishi": "Agent Rishi",
};

const DECISIONS: Readonly<Record<ApprovalDecision, string>> = {
  allow_once: "Allowed once",
  allow_session: "Allowed for the session",
  deny: "Denied",
};

const DECIDERS: Readonly<Record<ApprovalDecider, string>> = {
  user: "the user",
  policy: "Agent Rishi's permission policy",
  pm: "the project manager",
};

/** A list item whose continuation lines are indented under its first. */
function listItem(text: string, marker: "-" | "*" = "-"): string {
  const [first = "", ...rest] = text.split("\n");
  const head = `${marker} ${first}`;
  return rest.length ? `${head}\n${prefixLines(rest.join("\n"), "  ")}` : head;
}

/** A web link as an autolink when it's a plain URL, else as inline code. */
function link(url: string): string {
  return /^https?:\/\/[^\s<>]+$/.test(url) ? `<${url}>` : inlineCode(url);
}

/** The file name of an attachment; never its full path. */
function attachmentName(a: Attachment): string {
  if (a.name) return a.name;
  if (a.type === "file") return a.path.split(/[\\/]/).pop() || "file";
  return a.source.type === "path" ? a.source.path.split(/[\\/]/).pop() || "image" : "image";
}

/** A message to the session, under who sent it (a PM's brief never reads as the user's). */
export function userMessage(item: ItemOf<"user_message">): string {
  const { from, text } = splitSender(item.input.text, item.input.from);
  const parts = [`**${SENDERS[from]}**`, text.trim() || "_(no text)_"];
  const names = item.input.attachments.map(attachmentName);
  if (names.length > 0) parts.push(`_Attached:_ ${names.map(inlineCode).join(", ")}`);
  return parts.join("\n\n");
}

// ---------------------------------------------------------------- tool calls

function fileChange(change: FileChange, root: string | null): string {
  const path = inlineCode(relativeTo(change.path, root));
  const counts =
    change.additions !== undefined || change.deletions !== undefined
      ? ` +${change.additions ?? 0} −${change.deletions ?? 0}`
      : "";
  if (change.change === "add") return `${path} (new${counts})`;
  if (change.change === "delete") return `${path} (deleted)`;
  if (change.change === "rename" && change.previousPath) {
    return `${inlineCode(relativeTo(change.previousPath, root))} → ${path}${counts ? ` (${counts.trim()})` : ""}`;
  }
  return counts ? `${path} (${counts.trim()})` : path;
}

/** What a tool call did, as the start of its line, plus a code block for a multi-line command. */
function toolAction(item: ToolCallItem, ctx: ItemContext): { text: string; block?: string } {
  const { root } = ctx;
  const titled = (fallback: string) => {
    const title = item.title ? oneLine(item.title) : "";
    return title && title !== fallback ? `: ${cut(title, 200, ctx)}` : "";
  };
  switch (item.toolKind) {
    case "command": {
      const command = item.command.trim();
      if (command.includes("\n")) {
        return { text: "Ran", block: fenced(cut(command, COMMAND_BLOCK_MAX, ctx), "sh") };
      }
      return { text: `Ran ${inlineCode(cut(command, COMMAND_MAX, ctx))}` };
    }
    case "file_edit": {
      if (item.changes.length === 0) return { text: `Edited files${titled("")}` };
      const shown = item.changes.slice(0, FILES_SHOWN).map((c) => fileChange(c, root));
      const more = item.changes.length - shown.length;
      return { text: `Edited ${shown.join(", ")}${more > 0 ? ` and ${more} more` : ""}` };
    }
    case "file_read": {
      const { startLine: from, endLine: to } = item;
      const lines = from && to ? ` (lines ${from}–${to})` : from ? ` (from line ${from})` : "";
      return { text: `Read ${inlineCode(relativeTo(item.path, root))}${lines}` };
    }
    case "search": {
      const where = item.path ? ` in ${inlineCode(relativeTo(item.path, root))}` : "";
      const n = item.matchCount;
      const found = n === undefined ? "" : ` (${n} match${n === 1 ? "" : "es"})`;
      return { text: `Searched for ${inlineCode(item.query)}${where}${found}` };
    }
    case "web":
      if (item.url) return { text: `Fetched ${link(item.url)}` };
      if (item.query) return { text: `Searched the web for ${inlineCode(item.query)}` };
      return { text: `Used ${inlineCode(item.toolName)}${titled(item.toolName)}` };
    case "mcp":
      return { text: `Called ${inlineCode(`${item.server}/${item.tool}`)}${titled(item.tool)}` };
    case "browser":
      return { text: `Browser ${oneLine(item.action)}${item.url ? ` ${link(item.url)}` : ""}` };
    default:
      return { text: `Used ${inlineCode(item.toolName)}${titled(item.toolName)}` };
  }
}

const TOOL_STATUS: Readonly<Partial<Record<ItemStatus, string>>> = {
  failed: " — failed",
  declined: " — declined",
  cancelled: " — cancelled",
  in_progress: " — still running",
};

/** How a tool call ended, when not plainly: a non-zero exit code, failed, declined, running. */
function toolOutcome(item: ToolCallItem, ctx: ItemContext): string {
  const code = item.toolKind === "command" ? item.exitCode : null;
  const exit = code !== null && code !== undefined && code !== 0 ? ` (exit ${code})` : "";
  const why =
    item.status === "failed" && item.error ? `: ${cut(oneLine(item.error.message), 300, ctx)}` : "";
  return `${exit}${TOOL_STATUS[item.status] ?? ""}${why}`;
}

/** Images the call created, by caption (never the file or its path). */
function toolImages(item: ToolCallItem, ctx: ItemContext): string {
  const images = item.generatedImages ?? [];
  if (images.length === 0) return "";
  const captions = images.flatMap((i) =>
    i.caption ? [`"${cut(oneLine(i.caption), 120, ctx)}"`] : [],
  );
  const what = images.length === 1 ? "an image" : `${images.length} images`;
  return ` · created ${what}${captions.length ? `: ${captions.join(", ")}` : ""}`;
}

/**
 * One tool call as a list item (one line, plus a code block for a multi-line command). Tool
 * lists use `*` because every other list in the export uses `-`: a list right after a todo
 * list or an approval's facts would otherwise merge into it.
 */
export function toolLine(item: ToolCallItem, ctx: ItemContext): string {
  const { text, block } = toolAction(item, ctx);
  const line = `${text}${toolOutcome(item, ctx)}${toolImages(item, ctx)}`;
  return listItem(block ? `${line}:\n${block}` : line, "*");
}

const HOOK_OUTCOME: Readonly<Record<HookRunOutcome, string>> = {
  running: "still running",
  succeeded: "ran",
  failed: "failed",
  blocked: "blocked",
  cancelled: "cancelled",
};

/**
 * One hook run from the user's settings (§12.4) as an item of the tool list it ran between:
 * its event, what ran, how it ended and, for a failed or blocked run, the reason.
 */
export function hookLine(item: ItemOf<"hook_run">, ctx: ItemContext): string {
  const label = item.label ? ` ${inlineCode(cut(oneLine(item.label), 200, ctx))}` : "";
  const code = item.exitCode;
  const exit = typeof code === "number" && code !== 0 ? ` (exit ${code})` : "";
  const reason =
    (item.outcome === "failed" || item.outcome === "blocked") && item.output
      ? `: ${cut(oneLine(item.output), 300, ctx)}`
      : "";
  return listItem(
    `Hook ${item.event}${label} — ${HOOK_OUTCOME[item.outcome]}${exit}${reason}`,
    "*",
  );
}

// ---------------------------------------------------------------- questions and approvals

function unanswered(status: ItemStatus): string {
  if (status === "in_progress") return "_waiting for an answer_";
  if (status === "declined") return "_declined_";
  if (status === "cancelled") return "_not answered (withdrawn)_";
  return "_not answered_";
}

function questionBlock(item: ItemOf<"user_question">, speaker: string): string {
  const heading = item.mcpServer
    ? `**Form from MCP server ${inlineCode(item.mcpServer)}**`
    : `**${speaker} asked**`;
  const lines = item.questions.map((q) => {
    const head = q.header ? `**${oneLine(q.header)}:** ` : "";
    const answer = item.answers?.[q.id];
    const text = answer?.length ? answer.map(oneLine).join(", ") : unanswered(item.status);
    return listItem(`${head}${q.question.trim()}\n- Answer: ${text}`);
  });
  const parts = [heading, lines.join("\n")];
  if (item.answers && item.decidedBy) {
    parts.push(`_Answered by ${item.decidedBy === "pm" ? "the project manager" : "the user"}._`);
  }
  return parts.join("\n\n");
}

function decisionText(item: ItemOf<"approval_request">): string {
  if (item.decision) {
    const by = item.decidedBy ? `, by ${DECIDERS[item.decidedBy]}` : "";
    return `${DECISIONS[item.decision]}${by}`;
  }
  if (item.status === "in_progress") return "Waiting for an answer";
  if (item.status === "cancelled") return "Withdrawn";
  if (item.status === "declined") return "Denied";
  if (item.status === "failed") return "Failed";
  return "Answered";
}

function approvalBlock(item: ItemOf<"approval_request">, ctx: ItemContext): string {
  const facts: string[] = [];
  if (item.reason) facts.push(`Why: ${oneLine(item.reason)}`);
  if (item.command) facts.push(`Command: ${inlineCode(cut(item.command, COMMAND_MAX, ctx))}`);
  if (item.paths?.length) {
    facts.push(`Paths: ${item.paths.map((p) => inlineCode(relativeTo(p, ctx.root))).join(", ")}`);
  }
  if (item.url) facts.push(`Link: ${link(item.url)}`);
  facts.push(`Decision: ${decisionText(item)}`);
  return [
    `**Approval requested:** ${oneLine(item.title)}`,
    facts.map((f) => `- ${f}`).join("\n"),
  ].join("\n\n");
}

// ---------------------------------------------------------------- everything else

/**
 * Markdown for an item that isn't a tool call or a subagent, or null when it shows nothing in
 * the export (reasoning, follow-up chips, an empty reply).
 */
export function itemBlock(item: Item, ctx: ItemContext): string | null {
  switch (item.kind) {
    case "user_message":
      return userMessage(item);
    case "assistant_message":
      return item.text.trim() ? `**${ctx.speaker}**\n\n${item.text.trim()}` : null;
    case "plan":
      return item.text.trim() ? `**Plan**\n\n${item.text.trim()}` : null;
    case "todo_list": {
      if (item.todos.length === 0) return null;
      const lines = item.todos.map((t) => {
        const box = t.status === "completed" ? "[x]" : "[ ]";
        const doing = t.status === "in_progress" ? " _(in progress)_" : "";
        return `- ${box} ${oneLine(t.text)}${doing}`;
      });
      return `**Todo list**\n\n${lines.join("\n")}`;
    }
    case "user_question":
      return questionBlock(item, ctx.speaker);
    case "approval_request":
      return approvalBlock(item, ctx);
    case "notice":
      return quote(
        `**${item.level === "warning" ? "Warning" : "Notice"}:** ${item.message.trim()}`,
      );
    case "error":
      return quote(`**Error:** ${item.error.message.trim()}`);
    default:
      // Reasoning and follow-up chips stay out; tool calls, hook runs and subagents are
      // rendered elsewhere.
      return null;
  }
}
