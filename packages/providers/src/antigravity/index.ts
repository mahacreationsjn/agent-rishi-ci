/**
 * Antigravity CLI adapter: its ACP server (`agy acp`) driven by the generic ACP client, with
 * Agent Rishi's own strict settings (every tool action asks), discovery and its model list.
 */
export {
  ANTIGRAVITY_AGENT,
  ANTIGRAVITY_PROVIDER_ID,
  AntigravityAdapter,
  type AntigravityAdapterOptions,
} from "./adapter";
export {
  AGY_INSTALL_COMMAND,
  AGY_LOGIN_COMMAND,
  AGY_MIN_VERSION,
  AGY_UPGRADE_COMMAND,
  type AgyAuth,
  agyInstallCommand,
  agyTooOldMessage,
  detectAgy,
  isSupportedAgyVersion,
  readAgyAuth,
} from "./detect";
export {
  AGY_PLAN_APPROVED,
  AGY_PLAN_FILE,
  type AgyArtifact,
  agyArtifact,
  agyExtensions,
} from "./extensions";
export { AGY_EFFORT, agyModelInfos, fallbackAgyModels } from "./models";
export { AGY_ACP_ARGS, type AgyProbe, probeAgy } from "./probe";
export {
  type AgyElicitation,
  type AgyElicitationResult,
  type AgyQuestion,
  agyAnswerContent,
  agyQuestions,
  agyUserQuestions,
  answerAgyElicitation,
} from "./questions";
export { AGY_CLI_DIR, agentRishiAgySettings, agyDir, writeAgySettings } from "./settings";
