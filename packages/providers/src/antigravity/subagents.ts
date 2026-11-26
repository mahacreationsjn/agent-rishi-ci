import type { AcpInlineSubagents } from "../acp/subagents";
import { str } from "../util/text";

/** The id an Antigravity CLI subagent's tool calls start with: `<subagent uuid>:call_…`. */
const SUBAGENT_CALL = /^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}):/i;

/**
 * Antigravity CLI's subagents (§7.2). Over ACP they run inside the parent's session: its
 * `invoke_subagent` tool call starts one (raw input `Prompt`, `Role`, `TypeName`) and finishes
 * at once, then the subagent's own tool calls and permission requests arrive on the parent's
 * session under ids `<subagent id>:call_…`. Its messages aren't sent, and nothing says when it
 * ends: the parent's prompt stays open until every subagent has finished.
 */
export const AGY_SUBAGENTS: AcpInlineSubagents = {
  spawnTool: "invoke_subagent",
  task: (input) => {
    const description = str(input, "Role")?.trim();
    const prompt = str(input, "Prompt")?.trim();
    const agentType = str(input, "TypeName")?.trim();
    return {
      ...(description ? { description } : {}),
      ...(prompt ? { prompt } : {}),
      ...(agentType ? { agentType } : {}),
    };
  },
  childOf: (toolCallId) => SUBAGENT_CALL.exec(toolCallId)?.[1]?.toLowerCase(),
};
