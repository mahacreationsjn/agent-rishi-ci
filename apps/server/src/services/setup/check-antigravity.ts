import {
  AGY_MIN_VERSION,
  AGY_UPGRADE_COMMAND,
  agyTooOldMessage,
  isSupportedAgyVersion,
  readAgyAuth,
} from "@agent-rishi/providers";
import { base, type CheckEnv, type CheckResult, installFix } from "./check-base";
import { loginFix, lookupTool } from "./tool-lookup";

/**
 * Antigravity CLI (§14): a working `agy` (PATH, then `~/.local/bin`, where its installer puts it)
 * of at least the version Agent Rishi supports, then whether it is signed in: its Google sign-in's
 * token file exists (it is never read), or `GEMINI_API_KEY` is set. `agy acp --login` signs in
 * by pasting a code.
 */
export async function checkAntigravity({
  locate,
  shell,
  platform,
  userHome,
  env,
}: CheckEnv): Promise<CheckResult> {
  const tool = await lookupTool(
    locate,
    "agy",
    base("antigravity"),
    { message: "Antigravity CLI is not installed", fix: installFix("antigravity", platform) },
    { minVersion: AGY_MIN_VERSION },
  );
  if (!tool.found) return tool.result;
  const installed = {
    ...base("antigravity"),
    ...tool.extra,
    installed: true,
    version: tool.version,
    executablePath: tool.path,
  };
  if (!isSupportedAgyVersion(tool.version)) {
    return {
      ...installed,
      state: "missing",
      message: agyTooOldMessage(tool.version),
      fix: { kind: "upgrade", command: AGY_UPGRADE_COMMAND },
    };
  }
  const auth = readAgyAuth(userHome ?? undefined, env ?? process.env);
  if (!auth.loggedIn) {
    return {
      ...installed,
      loggedIn: false,
      state: "missing",
      message: "Not signed in to Antigravity CLI",
      fix: loginFix("antigravity", shell, tool.path),
    };
  }
  return {
    ...installed,
    loggedIn: true,
    authMethod: auth.authMethod,
    state: "ok",
    message: "Signed in",
  };
}
