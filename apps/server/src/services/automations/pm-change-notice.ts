import type { Automation, InboxItem } from "@agent-rishi/contracts";
import { structuredPatch } from "diff";
import { BEHAVIOUR_FIELDS } from "./approval";
import { automationToMarkdown } from "./markdown";

const MAX_VALUE = 120;
const MAX_DIFF_LINES = 80;

/**
 * Inbox id of the notice that a change switched an automation off (a PM's or its file's); the
 * next change replaces it.
 */
export function pmChangeInboxId(automationId: string): string {
  return `inbox:automation-changed:${automationId}`;
}

/** `path: before → after` for each trigger, action and guard setting that differs. */
export function automationChanges(before: Automation, after: Automation): string[] {
  const was = new Map<string, string>();
  const now = new Map<string, string>();
  for (const key of BEHAVIOUR_FIELDS) {
    flatten(before[key], key, was);
    flatten(after[key], key, now);
  }
  const out: string[] = [];
  for (const path of new Set([...was.keys(), ...now.keys()])) {
    if (was.get(path) === now.get(path)) continue;
    out.push(`${path}: ${shorten(was.get(path))} → ${shorten(now.get(path))}`);
  }
  return out;
}

function flatten(value: unknown, path: string, out: Map<string, string>): void {
  if (value === undefined) return;
  if (value !== null && typeof value === "object" && !Array.isArray(value)) {
    for (const [key, v] of Object.entries(value)) flatten(v, `${path}.${key}`, out);
    return;
  }
  out.set(path, JSON.stringify(value));
}

function shorten(text: string | undefined): string {
  if (text === undefined) return "none";
  return text.length > MAX_VALUE ? `${text.slice(0, MAX_VALUE - 1)}…` : text;
}

/**
 * The two definitions in the file format as a unified diff (`-` before, `+` after), so a long
 * prompt shows the lines that changed rather than its first characters.
 */
export function definitionDiff(before: Automation, after: Automation): string {
  const patch = structuredPatch(
    "before",
    "after",
    automationToMarkdown(before),
    automationToMarkdown(after),
    undefined,
    undefined,
    { context: 1 },
  );
  const lines = ["--- before", "+++ after"];
  for (const hunk of patch.hunks) {
    lines.push(`@@ -${hunk.oldStart},${hunk.oldLines} +${hunk.newStart},${hunk.newLines} @@`);
    lines.push(...hunk.lines);
  }
  if (lines.length <= MAX_DIFF_LINES) return lines.join("\n");
  const rest = lines.length - MAX_DIFF_LINES;
  return [...lines.slice(0, MAX_DIFF_LINES), `… ${rest} more lines: see the file`].join("\n");
}

const shortName = (name: string) => (name.length > 80 ? `${name.slice(0, 79)}…` : name);

function changeNotice(
  after: Automation,
  fields: Pick<InboxItem, "title" | "body" | "projectId" | "sessionId">,
  now: string,
): InboxItem {
  return {
    id: pmChangeInboxId(after.id),
    kind: "message",
    status: "open",
    priority: "normal",
    notify: "needs_you",
    ...fields,
    threadId: null,
    itemId: null,
    requestId: null,
    issue: null,
    pr: null,
    automationRunId: null,
    createdAt: now,
    updatedAt: now,
    resolvedAt: null,
    resolution: null,
  };
}

/**
 * The inbox item telling the user that the PM changed what an automation that was on does, so
 * it was switched off (§10): what changed, and that it runs again only once they switch it on.
 */
export function pmChangeInbox(
  before: Automation,
  after: Automation,
  by: { projectId: string; sessionId: string | null },
  now: string,
): InboxItem {
  return changeNotice(
    after,
    {
      title: `Automation switched off: the project manager changed "${shortName(after.name)}"`,
      body: [
        "The project manager changed what this automation does, so it was switched off. It runs again only once you switch it on in Automations.",
        `Changed: ${automationChanges(before, after).join("; ")}.`,
      ].join("\n"),
      projectId: by.projectId,
      sessionId: by.sessionId,
    },
    now,
  );
}

/**
 * The inbox item telling the user that an automation's file changed what an automation that
 * was on does, so it was switched off (§10): the file, what changed and the diff of the old and
 * new definition. An agent or a merged pull request may have written the file.
 */
export function fileChangeInbox(
  before: Automation,
  after: Automation,
  path: string | null,
  now: string,
): InboxItem {
  const where = path ? ` (${path})` : "";
  return changeNotice(
    after,
    {
      title: `Automation "${shortName(after.name)}" changed in its file: review and turn it back on`,
      body: [
        `Its file${where} changed what this automation does, so it was switched off. Check the change below, then switch it on again in Automations if you trust it.`,
        `Changed: ${automationChanges(before, after).join("; ")}.`,
        "",
        definitionDiff(before, after),
      ].join("\n"),
      projectId: after.target.type === "project" ? after.target.projectId : null,
      sessionId: null,
    },
    now,
  );
}
