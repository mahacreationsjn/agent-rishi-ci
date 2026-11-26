/**
 * Self-update end to end (§16) against a local fake registry serving the current build
 * relabelled as a newer version: check -> install with real npm -> current.json -> the launcher
 * of the published-style copy loads the new version, which reports its version.
 *
 * Needs `apps/cli/dist` (`pnpm build`); skipped without it unless AGENT_RISHI_REQUIRE_CLI_DIST=1.
 */
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { listInstalled, readPointer, UpdateService } from "@agent-rishi/server";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { CLI_ROOT, type FakeRegistry, packCli, startFakeRegistry } from "./support/fake-registry";
import { installPublishedCopy } from "./support/published-install";

const NEXT = "99.0.0-test";
const built = existsSync(join(CLI_ROOT, "dist", "cli.js"));
if (!built && process.env.AGENT_RISHI_REQUIRE_CLI_DIST === "1") {
  throw new Error("apps/cli/dist is missing: run `pnpm build` first");
}

describe.skipIf(!built)("self-update with a fake registry (§16)", () => {
  let registry: FakeRegistry;
  let base: string;
  let home: string;
  let entry: string;
  let current: string;
  const savedNpmConfig: NodeJS.ProcessEnv = {};
  const savedHomeEnv: NodeJS.ProcessEnv = {};

  const run = (args: string[], env: Record<string, string> = {}) =>
    execFileSync(process.execPath, [entry, ...args, "--home", home], {
      env: { ...process.env, AGENT_RISHI_HOME: "", ...env },
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();

  beforeAll(async () => {
    base = realpathSync.native(mkdtempSync(join(tmpdir(), "agent-rishi-self-update-")));
    const npmUserConfig = join(base, ".npmrc");
    writeFileSync(npmUserConfig, "");
    // pnpm exports the user's npm config as npm_config_*; keep it out of the real npm install.
    for (const key of Object.keys(process.env)) {
      if (key.toLowerCase().startsWith("npm_config_")) {
        savedNpmConfig[key] = process.env[key];
        delete process.env[key];
      }
    }
    process.env.NPM_CONFIG_USERCONFIG = npmUserConfig;
    for (const key of ["HOME", "USERPROFILE"]) {
      savedHomeEnv[key] = process.env[key];
      process.env[key] = base;
    }
    home = join(base, "home");
    // Linked runtime deps in <base>/node_modules also serve the version installed under <base>/home.
    entry = installPublishedCopy(base, { linkDeps: true });
    current = run(["--version"]);
    registry = await startFakeRegistry();
    registry.publish(NEXT, packCli({ version: NEXT, stripDependencies: true }));
    // A leaked dry-run setting would make npm skip installing the update.
    process.env.npm_config_dry_run = "true";
  }, 120_000);

  afterAll(async () => {
    for (const [key, value] of Object.entries(savedHomeEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    delete process.env.NPM_CONFIG_USERCONFIG;
    for (const key of Object.keys(process.env)) {
      if (key.toLowerCase().startsWith("npm_config_")) delete process.env[key];
    }
    Object.assign(process.env, savedNpmConfig);
    await registry?.close();
    rmSync(base, { recursive: true, force: true, maxRetries: 3 });
  });

  it("checks, installs side by side, switches and reports the new version", async () => {
    const restarts: Array<string | null> = [];
    const updates = new UpdateService({
      home,
      mode: () => "notify",
      registry: registry.url,
      current,
      host: {
        source: "packaged",
        restartCommand: "agent-rishi",
        launcherVersion: current,
        restart: ({ version }) => restarts.push(version),
      },
    });
    const checked = await updates.status({ refresh: true });
    expect(checked).toMatchObject({ current, latest: NEXT, updateAvailable: true, error: null });

    updates.install();
    const deadline = Date.now() + 240_000;
    while (restarts.length === 0 && updates.snapshot().state !== "failed") {
      if (Date.now() > deadline) throw new Error("install timed out");
      await new Promise((r) => setTimeout(r, 250));
    }
    expect(updates.snapshot().installError).toBeNull();
    expect(restarts).toEqual([NEXT]);
    expect(readPointer(home)).toMatchObject({ version: NEXT, previous: current });
    expect(listInstalled(home)).toEqual([{ version: NEXT, current: true, valid: true }]);
    expect(registry.requests).toContain("GET /-/package/agent-rishi/dist-tags");

    // The published-style copy's launcher now loads the installed version in-process.
    expect(run(["--version"])).toBe(NEXT);
    expect(run(["--version"], { AGENT_RISHI_NO_SWITCH: "1" })).toBe(current);
    // doctor exits non-zero without an agent CLI installed (CI); only its rows matter here.
    const doctor = spawnSync(process.execPath, [entry, "doctor", "--home", home], {
      encoding: "utf8",
    });
    expect(doctor.stdout, doctor.stderr).toContain(`Installed versions   ${NEXT} (current)`);
  }, 300_000);

  it("falls back to the launched copy when the pinned version is broken", () => {
    const pkg = join(home, "app", NEXT, "node_modules", "agent-rishi", "package.json");
    writeFileSync(pkg, JSON.stringify({ name: "agent-rishi", version: "0.0.1" }));
    const out = execFileSync(process.execPath, [entry, "--version", "--home", home], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    expect(out.trim()).toBe(current);
  });
});
