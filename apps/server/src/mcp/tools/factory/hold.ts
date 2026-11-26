import {
  FACTORY_HOLD_LABEL,
  FactoryHoldRequest,
  FactoryReleaseRequest,
} from "@agent-rishi/contracts";
import { defineTool } from "../../define";
import { asTool, inFactoryProject } from "./shared";

/** The PM's hold on factory work (§10.1, Held work): keep an issue out of the loop, or let it back. */

/** `factory_hold_issue`: keep an open issue out of the factory loop until it is released. */
export const factoryHoldIssue = defineTool({
  name: "factory_hold_issue",
  description: `Keep an open issue out of the factory loop, for example while it waits on a decision, another pull request or an environment that isn't ready. It puts the \`${FACTORY_HOLD_LABEL}\` label on the issue and records your reason (also posted on the issue). The loop never takes a held issue in, and an item of it still waiting in the queue is parked; work already in progress carries on (stop its session with stop_session and a reason if it must stop: that is recorded as your stop, not a failure). factory_status lists held issues with their reasons. Release it with factory_release_issue (or by removing the label on GitHub); the loop picks it up on its next check.`,
  roles: ["pm"],
  scope: "project",
  alwaysLoad: true,
  isAvailable: inFactoryProject,
  input: FactoryHoldRequest,
  handler: async (input, { services, projectId }) =>
    asTool(() => services.factory.hold(projectId, input, "pm")),
});

/** `factory_release_issue`: let a held issue back into the factory loop. */
export const factoryReleaseIssue = defineTool({
  name: "factory_release_issue",
  description: `Let an issue you held (or that carries the \`${FACTORY_HOLD_LABEL}\` label) back into the factory loop: the label comes off, and on its next check the loop takes the issue in, or its parked item goes on from the queue. Give the reason when there is one (the prerequisite merged, the decision was made); it is noted on the item and posted on the issue.`,
  roles: ["pm"],
  scope: "project",
  alwaysLoad: true,
  isAvailable: inFactoryProject,
  input: FactoryReleaseRequest,
  handler: async (input, { services, projectId }) =>
    asTool(() => services.factory.release(projectId, input, "pm")),
});
