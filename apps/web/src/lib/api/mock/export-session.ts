import {
  redactAndCount,
  type SessionSnapshot,
  type SessionTranscriptExport,
} from "@agent-rishi/contracts";

/**
 * The mock's "export as Markdown": the title and the root thread's messages, secrets redacted.
 * The real export is written by the server (`GET /api/sessions/:id/export`), with tool calls,
 * subagents and cost.
 */
export function mockExportSession(snap: SessionSnapshot): SessionTranscriptExport {
  const { session } = snap;
  const title = session.title ?? session.purpose;
  const blocks = [`# ${title}`, "_Exported from the Agent Rishi mock._", "---"];
  for (const { threadId, item } of snap.items) {
    if (threadId !== session.rootThreadId) continue;
    if (item.kind === "user_message") blocks.push(`**User**\n\n${item.input.text.trim()}`);
    if (item.kind === "assistant_message" && item.text.trim()) {
      blocks.push(`**Agent**\n\n${item.text.trim()}`);
    }
  }
  const slug =
    title
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 60)
      .replace(/-+$/, "") || "session";
  const date = new Date().toISOString().slice(0, 10);
  const markdown = redactAndCount(`${blocks.join("\n\n")}\n`).text;
  return { fileName: `${slug}-${date}.md`, markdown };
}
