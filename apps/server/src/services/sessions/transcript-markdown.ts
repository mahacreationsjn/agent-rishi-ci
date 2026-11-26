import {
  type ForkKind,
  type ItemOf,
  type ItemRecord,
  type Role,
  redactAndCount,
  type Session,
  type SessionStatus,
  type SessionUsage,
  type Thread,
  type Turn,
  type TurnUsage,
} from "@agent-rishi/contracts";
import {
  duration,
  escapeFolds,
  inlineCode,
  oneLine,
  quote,
  slug,
  tokenCount,
  usd,
  utcTime,
} from "./transcript-format";
import { hookLine, type ItemContext, itemBlock, toolLine } from "./transcript-items";

/** Everything a session's Markdown export is written from (§13). */
export interface TranscriptSource {
  session: Session;
  projectName: string | null;
  /** Display name of the session's provider. */
  providerName: string;
  /** Title of the session it was forked, handed off or reviewed from, when it still exists. */
  forkedFromTitle: string | null;
  threads: Thread[];
  /** Oldest first. */
  turns: Turn[];
  items: ItemRecord[];
  /** The ledger's figures; null when they couldn't be read. */
  usage: SessionUsage | null;
  exportedAt: Date;
  /** Agent Rishi's version, named in the footer line. */
  version: string;
  /** Exact values to hide wherever they appear (Agent Rishi's install token), besides known shapes. */
  knownSecrets?: readonly string[];
}

const STATUS: Readonly<Record<SessionStatus, string>> = {
  created: "Created",
  queued: "Queued",
  starting: "Starting",
  running: "Working",
  waiting: "Needs you",
  idle: "Idle",
  interrupted: "Interrupted",
  completed: "Done",
  failed: "Failed",
  stopped: "Stopped",
};

/** How a session made from another one names its source (§9). */
const FORK_HOW: Readonly<Record<ForkKind, string>> = {
  fork: "Forked from",
  handoff: "Handed off from",
  review: "Review of",
};

/** Who writes the replies in a session's own threads. */
const SPEAKERS: Readonly<Record<Role, string>> = {
  agent: "Agent",
  pm: "Project manager",
  orchestrator: "Orchestrator",
};

/** The export's heading: the session's title, or the role for the orchestrator and PMs. */
export function transcriptTitle(session: Session, projectName: string | null): string {
  if (session.role === "orchestrator") return "Orchestrator";
  if (session.role === "pm") {
    return projectName ? `Project manager · ${oneLine(projectName)}` : "Project manager";
  }
  return oneLine(session.title ?? session.purpose) || "Session";
}

/**
 * `<slug of the title>-<YYYY-MM-DD>.md`, or `session-<id8>-<date>.md` for a title with no slug.
 * The title is redacted first, so a secret in it can't reach the file name.
 */
export function transcriptFileName(
  session: Session,
  exportedAt: Date,
  projectName: string | null = null,
  knownSecrets: readonly string[] = [],
): string {
  const date = exportedAt.toISOString().slice(0, 10);
  const title = redactAndCount(transcriptTitle(session, projectName), { known: knownSecrets }).text;
  const stem = slug(title) || `session-${slug(session.id, 8)}`;
  return `${stem}-${date}.md`;
}

/**
 * A session's transcript as Markdown, to paste into an issue, a PR or a write-up: a facts list
 * with the ledger's cost (labelled as in §12.6), then each turn of the root thread with its
 * messages, plans, todos, questions, approvals, notices, one line per tool call, and subagents
 * with their own threads folded into `<details>`. Reasoning, tool output and diffs are left out.
 * Secrets are replaced with `[redacted]` (`redactAndCount`), and the header says how many.
 */
export function sessionTranscriptMarkdown(src: TranscriptSource): string {
  let redacted = 0;
  const redact = (text: string) => {
    const r = redactAndCount(text, { known: src.knownSecrets ?? [] });
    redacted += r.count;
    return r.text;
  };
  // Text cut short is redacted while rendering; everything is checked again once written.
  const rest = redact(body(src, redact).join("\n\n"));
  const head = redact(escapeFolds(header(src)));
  return `${[head, redactionNote(redacted), "---", rest].filter(Boolean).join("\n\n")}\n`;
}

/** The header's line saying how many values were hidden; none when nothing was. */
function redactionNote(count: number): string | null {
  if (count === 0) return null;
  const values = `${count} value${count === 1 ? "" : "s"}`;
  return `_${values} redacted: anything that looked like a secret (a token, a key, a password) was replaced._`;
}

// ---------------------------------------------------------------- header

function linkText(text: string): string {
  return oneLine(text).replace(/[[\]]/g, "\\$&");
}

/** The session's cost from the ledger, labelled as the app labels it (§12.6). */
export function costFact(usage: SessionUsage | null): string | null {
  if (!usage) return null;
  const t = usage.totals;
  if (t.turns === 0) return "no usage recorded yet";
  const total = t.inputTokens + t.outputTokens + t.cacheReadTokens + t.cacheWriteTokens;
  const size = `${tokenCount(total)} tokens · ${t.turns} turn${t.turns === 1 ? "" : "s"}`;
  if (t.unpricedTurns === t.turns) {
    return `Not priced (the model has no price and the provider reported no cost) · ${size}`;
  }
  const estimated = t.estimatedCostUsd > 0;
  const kind = usage.billing === "subscription" ? " API-equivalent" : "";
  const how = estimated ? " (estimated from list prices)" : "";
  const unpriced = t.unpricedTurns > 0 ? ` · ${t.unpricedTurns} not priced` : "";
  return `${usd(t.costUsd, estimated)}${kind}${how}${unpriced} · ${size}`;
}

function header(src: TranscriptSource): string {
  const s = src.session;
  const facts: string[] = [];
  if (src.projectName) facts.push(`**Project:** ${oneLine(src.projectName)}`);
  const agent = [src.providerName, s.model, s.effort ? `${s.effort} effort` : null];
  facts.push(`**Provider:** ${agent.filter(Boolean).join(" · ")}`);
  if (s.role !== "agent") facts.push(`**Role:** ${SPEAKERS[s.role]}`);
  if (s.branch) {
    const base = s.baseBranch ? ` from ${inlineCode(s.baseBranch)}` : "";
    facts.push(`**Branch:** ${inlineCode(s.branch)}${base}`);
  }
  if (s.issue) {
    const title = s.issue.title ? ` ${linkText(s.issue.title)}` : "";
    facts.push(`**Issue:** [#${s.issue.number}${title}](${s.issue.url})`);
  }
  if (s.pr) {
    const title = s.pr.title ? ` ${linkText(s.pr.title)}` : "";
    facts.push(`**Pull request:** [#${s.pr.number}${title}](${s.pr.url}) (${s.pr.state})`);
  }
  if (s.forkedFrom) {
    const how = FORK_HOW[s.forkedFrom.kind ?? "fork"];
    facts.push(`**${how}:** ${oneLine(src.forkedFromTitle ?? "another session")}`);
  }
  facts.push(`**Started:** ${utcTime(s.createdAt)} · **Last activity:** ${utcTime(s.updatedAt)}`);
  facts.push(`**Status:** ${STATUS[s.status]}${s.archivedAt ? " (archived)" : ""}`);
  if (s.result) facts.push(`**Result:** ${s.result.outcome}. ${oneLine(s.result.summary)}`);
  const cost = costFact(src.usage);
  if (cost) facts.push(`**Cost:** ${cost}`);
  return [
    `# ${transcriptTitle(s, src.projectName)}`,
    facts.map((f) => `- ${f}`).join("\n"),
    `_Exported from Agent Rishi ${src.version} on ${utcTime(src.exportedAt.toISOString())}. Reasoning, tool output and diffs are left out._`,
  ].join("\n\n");
}

// ---------------------------------------------------------------- turns and threads

/** What walking the threads needs: items by thread, the session's root, the ledger. */
interface Walk {
  src: TranscriptSource;
  byThread: Map<string, ItemRecord[]>;
  /** Threads already rendered, so a malformed link can't loop. */
  seen: Set<string>;
  root: string | null;
  redact: (text: string) => string;
}

function turnCost(t: TurnUsage): string {
  const total = t.inputTokens + t.outputTokens + t.cacheReadTokens + t.cacheWriteTokens;
  const cost =
    t.costSource === "unpriced" && total > 0
      ? "not priced"
      : usd(t.costUsd, t.costSource === "estimated");
  return `${cost} · ${tokenCount(total)} tokens`;
}

function turnHeading(n: number, turn: Turn | undefined, usage: TurnUsage | undefined): string {
  const parts = [`## Turn ${n}`];
  if (turn) parts.push(utcTime(turn.startedAt));
  if (usage) parts.push(turnCost(usage));
  if (turn?.status === "running") parts.push("still running");
  if (turn?.status === "failed" || turn?.status === "interrupted") parts.push(turn.status);
  return parts.join(" · ");
}

function body(src: TranscriptSource, redact: (text: string) => string): string[] {
  const byThread = new Map<string, ItemRecord[]>();
  for (const record of [...src.items].sort((a, b) => a.position - b.position)) {
    const list = byThread.get(record.threadId) ?? [];
    list.push(record);
    byThread.set(record.threadId, list);
  }
  const walk: Walk = {
    src,
    byThread,
    seen: new Set(),
    root: src.session.worktreePath ?? src.session.cwd,
    redact,
  };
  // Subagent threads render under their card; every other thread is a conversation of turns.
  const children = new Set(
    src.items.flatMap((r) => (r.item.kind === "subagent" ? [r.item.childThreadId] : [])),
  );
  const order = [
    ...[...src.threads].sort((a, b) => a.createdAt.localeCompare(b.createdAt)).map((t) => t.id),
    ...src.turns.map((t) => t.threadId),
    ...byThread.keys(),
  ];
  const roots = [...new Set(order)].filter((id) => !children.has(id));
  const blocks: string[] = [];
  let n = 0;
  for (const threadId of roots) {
    walk.seen.add(threadId);
    const turns = src.turns.filter((t) => t.threadId === threadId);
    const records = byThread.get(threadId) ?? [];
    const turnIds = [...new Set([...turns.map((t) => t.id), ...records.map((r) => r.turnId)])];
    const ctx: ItemContext = { root: walk.root, speaker: SPEAKERS[src.session.role], redact };
    for (const turnId of turnIds) {
      const turn = turns.find((t) => t.id === turnId);
      const usage = src.usage?.turns.find((t) => t.turnId === turnId);
      blocks.push(turnHeading(++n, turn, usage));
      blocks.push(
        ...renderItems(
          records.filter((r) => r.turnId === turnId),
          ctx,
          walk,
        ),
      );
      if (turn?.error && turn.status !== "completed") {
        const what = turn.status === "interrupted" ? "Turn interrupted" : "Turn failed";
        blocks.push(escapeFolds(quote(`**${what}:** ${turn.error.message.trim()}`)));
      }
    }
  }
  return blocks.length > 0 ? blocks : ["_No messages yet._"];
}

/**
 * A thread's items as Markdown blocks; consecutive tool calls (and the hook runs between them)
 * share one list. Literal fold tags
 * in what the items say are escaped (`escapeFolds`), so only a subagent's own fold opens one.
 */
function renderItems(records: ItemRecord[], ctx: ItemContext, walk: Walk): string[] {
  const blocks: string[] = [];
  let tools: string[] = [];
  const flush = () => {
    if (tools.length > 0) blocks.push(escapeFolds(tools.join("\n")));
    tools = [];
  };
  for (const { item } of records) {
    if (item.kind === "tool_call" || item.kind === "hook_run") {
      tools.push(item.kind === "tool_call" ? toolLine(item, ctx) : hookLine(item, ctx));
      continue;
    }
    flush();
    if (item.kind === "subagent") {
      blocks.push(subagentBlock(item, walk));
      continue;
    }
    const block = itemBlock(item, ctx);
    if (block) blocks.push(escapeFolds(block));
  }
  flush();
  return blocks;
}

/** What a subagent run cost, from the ledger's pricing of its tokens (display only, §7.3). */
function subagentCost(item: ItemOf<"subagent">, usage: SessionUsage | null): string | null {
  const cost = usage?.subagents.find((c) => c.itemId === item.id);
  if (!cost) return null;
  if (cost.costSource === "unpriced") return "not priced";
  const kind = usage?.billing === "subscription" ? " API-equivalent" : "";
  return `${usd(cost.costUsd, cost.costSource === "estimated")}${kind}`;
}

/**
 * A subagent card: who and what, its cost and stats, its result, then its own thread folded
 * into `<details>` (blank lines around the content, so GitHub renders its Markdown).
 */
function subagentBlock(item: ItemOf<"subagent">, walk: Walk): string {
  const name = item.agentType ? `Subagent ${inlineCode(item.agentType)}` : "Subagent";
  const facts: string[] = [];
  const cost = subagentCost(item, walk.src.usage);
  if (cost) facts.push(cost);
  const stats = item.stats;
  if (stats?.totalTokens !== undefined) facts.push(`${tokenCount(stats.totalTokens)} tokens`);
  if (stats?.toolUses !== undefined) {
    facts.push(`${stats.toolUses} tool call${stats.toolUses === 1 ? "" : "s"}`);
  }
  if (stats?.durationMs !== undefined) facts.push(duration(stats.durationMs));
  if (item.status === "in_progress") facts.push("still running");
  else if (item.status !== "completed") facts.push(item.status);
  const what = item.description ? `: ${oneLine(item.description)}` : "";
  const parts = [escapeFolds([`**${name}**${what}`, ...facts].join(" · "))];
  if (item.summary?.trim()) parts.push(escapeFolds(quote(item.summary.trim())));

  const childId = item.childThreadId;
  const records = walk.seen.has(childId) ? [] : (walk.byThread.get(childId) ?? []);
  walk.seen.add(childId);
  const inner: string[] = [];
  if (item.prompt?.trim()) inner.push(`**Task**\n\n${escapeFolds(item.prompt.trim())}`);
  const ctx: ItemContext = { root: walk.root, speaker: "Subagent", redact: walk.redact };
  inner.push(...renderItems(records, ctx, walk));
  if (inner.length > 0) {
    const steps = records.length;
    const label = steps > 0 ? `Its thread (${steps} step${steps === 1 ? "" : "s"})` : "Its task";
    parts.push([`<details>\n<summary>${label}</summary>`, ...inner, "</details>"].join("\n\n"));
  }
  return parts.join("\n\n");
}
