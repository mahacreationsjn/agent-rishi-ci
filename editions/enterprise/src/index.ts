import { EditionConfig } from "@agent-rishi/contracts";

/** Agent Rishi Enterprise (`docs/foundation.md`): checked against the contract when it loads. */
export const edition: EditionConfig = EditionConfig.parse({
  id: "enterprise",
  name: "Agent Rishi Enterprise",
  summary:
    "In a company, each department head builds and runs their own virtual agent team for technical and development work, with the models the company allows.",
  platforms: ["linux"],
});
