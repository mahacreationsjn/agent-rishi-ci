import { EditionConfig } from "@agent-rishi/contracts";

/** Agent Rishi Solo (`docs/foundation.md`): checked against the contract when it loads. */
export const edition: EditionConfig = EditionConfig.parse({
  id: "solo",
  name: "Agent Rishi Solo",
  summary:
    "One person runs a whole company, technical and business work, with virtual agent teams.",
  platforms: ["win32", "linux"],
});
