import { type InboxPmResolution, pmResolveRefusal } from "@agent-rishi/contracts";
import { z } from "zod";
import { defineTool, ToolError } from "../../define";

/**
 * `list_project_inbox` (§11.1): every open inbox item of the PM's project, so it can find stale
 * ones without the status digest's short list. Each line says whether the PM may resolve it.
 */
export const listProjectInbox = defineTool({
  name: "list_project_inbox",
  description:
    "List every open inbox item of this project (the status digest shows only the first few): id, kind, title, linked issue/PR and age. Items marked 'you may resolve' are triage decisions and informational messages you can clear with resolve_inbox_item once they're stale (for example a 'Should I take this on?' item whose issue is already closed).",
  roles: ["pm"],
  scope: "project",
  input: z.object({}),
  handler: async (_input, { services, projectId }) => {
    const items = services.inbox.list({ projectId });
    if (items.length === 0) return "The inbox has no open items for this project.";
    const lines = items.map((item) => {
      const links = [
        item.issue ? `issue #${item.issue.number}` : null,
        item.pr ? `PR #${item.pr.number}` : null,
      ].filter((s) => s !== null);
      const yours = pmResolveRefusal(item, projectId) === null ? " · you may resolve" : "";
      const linked = links.length ? ` · ${links.join(", ")}` : "";
      return `- ${item.id} · ${item.kind} · ${item.title}${linked} · since ${item.createdAt}${yours}`;
    });
    return [`${items.length} open inbox item(s):`, ...lines].join("\n");
  },
});

/**
 * `resolve_inbox_item` (§11.1): the PM dismisses a stale triage decision or informational
 * message of its own project, with a reason. The user sees who did it and why, and can restore
 * it from the inbox. Approvals, questions, MCP forms, other kinds and other projects' items
 * are refused (`pmResolveRefusal`).
 */
export const resolveInboxItem = defineTool({
  name: "resolve_inbox_item",
  description:
    "Clear a stale item from this project's inbox: a triage decision ('Should I take this on?') or an informational message, for example one whose issue is already closed or whose work is done. Give a short reason; the user sees it and can restore the item. Approvals, questions, MCP forms, other kinds and other projects' items stay with the user and are refused.",
  roles: ["pm"],
  scope: "project",
  input: z.object({
    inboxItemId: z.string().min(1),
    reason: z.string().min(1).max(500).describe("Why the item is stale, in one sentence"),
  }),
  handler: async ({ inboxItemId, reason }, { services, projectId, sessionId }) => {
    const item = services.inbox.find(inboxItemId);
    if (!item) throw new ToolError(`No inbox item ${inboxItemId}`);
    const refusal = pmResolveRefusal(item, projectId);
    if (refusal) throw new ToolError(refusal);
    const resolution: InboxPmResolution = { by: "pm", reason, sessionId };
    services.inbox.close(item, "dismissed", resolution);
    return `Resolved ${item.id} (${item.title}). The user can restore it from the inbox.`;
  },
});
