import type { SetupToolId } from "@agent-rishi/contracts";
import { isElectronRuntime } from "@agent-rishi/providers";
import { detectBrowser } from "./browsers";
import { base, type CheckEnv, type CheckResult, installFix, MIN_NODE_MAJOR } from "./check-base";
import { parseGhAuthJson, parseGhAuthText, parseVersion } from "./parse";
import type { ProviderCheckId } from "./provider-checks";
import { loginFix, lookupTool } from "./tool-lookup";

export type { CheckEnv };
export { MIN_NODE_MAJOR };

/**
 * The tools setup checks itself. The agent providers are not among them: their rows show the
 * runner's detection (`./provider-checks`, Foundation §4.3).
 */
export type ToolCheckId = Exclude<SetupToolId, ProviderCheckId>;

export async function checkGh({ exec, locate, shell, platform }: CheckEnv): Promise<CheckResult> {
  const tool = await lookupTool(locate, "gh", base("gh"), {
    message: "GitHub CLI is not installed (optional)",
    fix: installFix("gh", platform),
  });
  if (!tool.found) return tool.result;
  const installed = {
    ...base("gh"),
    ...tool.extra,
    installed: true,
    version: tool.version,
    executablePath: tool.path,
  };
  // `--json hosts` never includes the token; the text fallback is parsed for the login only.
  const json = await exec(tool.path, ["auth", "status", "--json", "hosts"], { timeoutMs: 10_000 });
  let auth = parseGhAuthJson(json.stdout);
  if (!auth) {
    const text = await exec(tool.path, ["auth", "status"], { timeoutMs: 10_000 });
    auth = parseGhAuthText(
      text.code,
      `${text.stdout}
${text.stderr}`,
    );
  }
  if (!auth.loggedIn) {
    return {
      ...installed,
      loggedIn: false,
      state: "missing",
      message: "Not signed in to GitHub",
      fix: loginFix("gh", shell, tool.path),
    };
  }
  return { ...installed, loggedIn: true, account: auth.account, state: "ok", message: "Signed in" };
}

export async function checkGit({ exec, platform }: CheckEnv): Promise<CheckResult> {
  const check = base("git");
  const version = await exec("git", ["--version"], { timeoutMs: 10_000 });
  if (version.notFound || version.code !== 0) {
    return {
      ...check,
      state: "missing",
      message: "git is not installed",
      fix: installFix("git", platform),
    };
  }
  const [name, email] = await Promise.all([
    exec("git", ["config", "--get", "user.name"], { timeoutMs: 5_000 }),
    exec("git", ["config", "--get", "user.email"], { timeoutMs: 5_000 }),
  ]);
  const user = name.stdout.trim();
  const mail = email.stdout.trim();
  const installed = {
    ...check,
    installed: true,
    version: parseVersion(version.stdout),
    executablePath: version.path,
    account: user && mail ? `${user} <${mail}>` : user || mail || null,
  };
  if (!user || !mail) {
    return {
      ...installed,
      state: "warning",
      message: "git user.name and user.email are not set",
      fix: {
        kind: "configure",
        command:
          'git config --global user.name "Your Name" && git config --global user.email you@example.com',
      },
    };
  }
  return { ...installed, state: "ok", message: "Identity configured" };
}

export async function checkBrowser({
  exec,
  platform,
  browserProbe,
}: CheckEnv): Promise<CheckResult> {
  const check = base("browser");
  const found = await detectBrowser({
    platform,
    ...browserProbe,
    exec: browserProbe?.exec ?? exec,
  });
  if (!found) {
    return {
      ...check,
      state: "warning",
      message: "No Edge or Chrome found (needed for the browser panel)",
      fix: installFix("browser", platform),
    };
  }
  return {
    ...check,
    installed: true,
    executablePath: found.path,
    state: "ok",
    message: found.name,
  };
}

export async function checkNode({ nodeVersion, platform }: CheckEnv): Promise<CheckResult> {
  const check = {
    ...base("node"),
    installed: true,
    version: nodeVersion.replace(/^v/, ""),
    executablePath: process.execPath,
  };
  const major = Number(/^v?(\d+)/.exec(nodeVersion)?.[1] ?? 0);
  if (major < MIN_NODE_MAJOR) {
    return {
      ...check,
      state: "missing",
      message: `Node.js ${MIN_NODE_MAJOR}+ is required`,
      fix: installFix("node", platform),
    };
  }
  // The desktop app runs on the Node.js built into it; no system Node.js is needed (§17).
  if (isElectronRuntime()) {
    return { ...check, state: "ok", message: `Node.js ${check.version} (built into the app)` };
  }
  return { ...check, state: "ok", message: `Node.js ${check.version}` };
}

export const CHECKS: Record<ToolCheckId, (env: CheckEnv) => Promise<CheckResult>> = {
  gh: checkGh,
  git: checkGit,
  browser: checkBrowser,
  node: checkNode,
};
