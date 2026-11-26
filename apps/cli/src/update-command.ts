import { AGENT_RISHI_VERSION, isNewerVersion, UpdateStatus } from "@agent-rishi/contracts";
import {
  applyRollback,
  ensureInstallToken,
  fetchLatestVersion,
  homePaths,
  installAppVersion,
  pruneInstalled,
  updateRegistry,
  writePointer,
} from "@agent-rishi/server";
import type { LaunchInfo } from "./launcher";
import { findRunningServer } from "./running";

const FROM_SOURCE =
  "Agent Rishi updates from its git repository: `git pull`, `pnpm install` and `pnpm build`, then restart it.";

/**
 * `agent-rishi update [--rollback]` (§16). With a server running it asks that server to update or
 * roll back (it restarts itself, like the "Update now" button); otherwise it installs the latest
 * version into `<home>/app` and points `current.json` at it for the next launch.
 */
export async function updateCommand(
  home: string,
  opts: { rollback: boolean; launch: LaunchInfo },
): Promise<number> {
  // Agent Rishi has no npm package or release feed of its own: it updates from git.
  if (opts.launch.source === "source" || process.env.AGENT_RISHI_UPDATE_CHECK !== "1") {
    console.error(FROM_SOURCE);
    return 1;
  }
  const paths = homePaths(home);
  const running = await findRunningServer(paths.serverLock);
  if (running) return viaServer(running.port, ensureInstallToken(paths.token), opts.rollback);

  if (opts.rollback) {
    const result = applyRollback(home, opts.launch.binVersion);
    if (!result) {
      console.log("Nothing to roll back to: no version was installed by `agent-rishi update`.");
      return 1;
    }
    console.log(
      `Rolled back. Agent Rishi ${result.next} starts next time (${opts.launch.restartCommand}).`,
    );
    return 0;
  }

  const registry = updateRegistry();
  let latest: string;
  try {
    latest = await fetchLatestVersion(registry);
  } catch (error) {
    console.error(`Couldn't check for updates: ${error instanceof Error ? error.message : error}`);
    return 1;
  }
  if (!isNewerVersion(latest, AGENT_RISHI_VERSION)) {
    console.log(`Agent Rishi ${AGENT_RISHI_VERSION} is the latest version.`);
    return 0;
  }
  console.log(`Installing Agent Rishi ${latest} ...`);
  try {
    await installAppVersion({
      home,
      version: latest,
      registry,
      onProgress: (line) => console.log(`  ${line}`),
    });
  } catch (error) {
    console.error(`The update failed: ${error instanceof Error ? error.message : error}`);
    return 1;
  }
  writePointer(home, latest, AGENT_RISHI_VERSION);
  pruneInstalled(home, [AGENT_RISHI_VERSION]);
  console.log(`Updated to ${latest}. Start Agent Rishi with \`${opts.launch.restartCommand}\`.`);
  return 0;
}

/** Ask the running server to update (or roll back), printing its progress until it restarts. */
async function viaServer(port: number, token: string, rollback: boolean): Promise<number> {
  const base = `http://127.0.0.1:${port}/api/updates`;
  const headers = { authorization: `Bearer ${token}`, "content-type": "application/json" };
  const res = await fetch(`${base}/${rollback ? "rollback" : "install"}`, {
    method: "POST",
    headers,
    body: "{}",
  });
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: { message?: string } };
    console.error(body.error?.message ?? `The server answered ${res.status}`);
    return 1;
  }
  console.log(
    rollback ? "Rolling back the running Agent Rishi ..." : "Updating the running Agent Rishi ...",
  );
  let last = "";
  for (let i = 0; i < 1200; i++) {
    let status: UpdateStatus;
    try {
      const poll = await fetch(base, { headers, signal: AbortSignal.timeout(5000) });
      status = UpdateStatus.parse(await poll.json());
    } catch {
      console.log("Agent Rishi is restarting; the browser reconnects on its own.");
      return 0;
    }
    const line = status.progress ?? status.state;
    if (line !== last) console.log(`  ${line}`);
    last = line;
    if (status.state === "failed") {
      console.error(`The update failed: ${status.installError}`);
      return 1;
    }
    if (status.state === "restarting") {
      console.log(
        `Agent Rishi is restarting as ${status.target}; the browser reconnects on its own.`,
      );
      return 0;
    }
    if (status.state === "installed" && !status.canRestart) {
      console.log(
        `Agent Rishi ${status.target} is installed. Restart it: ${status.restartCommand}`,
      );
      return 0;
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  return 1;
}
