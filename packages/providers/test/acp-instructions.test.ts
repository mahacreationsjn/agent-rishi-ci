import { describe, expect, it } from "vitest";
import { promptBlocks, withInstructions } from "../src/acp/items";

// ACP agents take no system prompt, so Agent Rishi's goes in front of the first prompt. That is why
// they don't declare `capabilities.systemPrompt` and get no token saver note (#602).
describe("ACP instructions", () => {
  const input = { text: "Fix the build", attachments: [] };
  const system =
    "# Working inside Agent Rishi\n\n## How to work\n\n- Keep going until the task is done.";

  it("prefixes the first prompt with the system prompt", () => {
    const [first] = promptBlocks(withInstructions(input, system), false);
    expect(first).toEqual({
      type: "text",
      text: `<instructions>\n${system}\n</instructions>\n\nFix the build`,
    });
  });

  it("leaves the prompt alone without instructions", () => {
    expect(withInstructions(input, undefined)).toBe(input);
  });
});
