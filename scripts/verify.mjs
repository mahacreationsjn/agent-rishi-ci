#!/usr/bin/env node
/**
 * The CI check, run locally: what `.github/workflows/ci.yml` runs on every pull request, in the
 * same order, on whatever machine you are on (Windows included; no bash needed). Use it before
 * opening or merging a pull request while hosted CI is unavailable.
 *
 *   node scripts/verify.mjs                 every step
 *   node scripts/verify.mjs --quick         install, typecheck, lint, test
 *   node scripts/verify.mjs --only lint,test
 *   node scripts/verify.mjs --skip install --from test
 *   node scripts/verify.mjs --keep-going    run every step even after a failure
 *   node scripts/verify.mjs --port 4791     port for the packed CLI's server
 *
 * Steps: install, typecheck, lint, test, build, self-update, packed-cli. `pnpm test` runs from
 * the repository root so `vitest.config.ts` applies its per-project timeouts: running a
 * package's suite from its own folder gets Vitest's 5 s default, and process-heavy tests then
 * time out on Windows. Exits non-zero when a step fails.
 */
import { spawn, spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(fileURLToPath(new URL("..", import.meta.url)));
const WIN = process.platform === "win32";

export const STEPS = [
  { id: "install", title: "Install dependencies (frozen lockfile)" },
  { id: "typecheck", title: "Typecheck" },
  { id: "lint", title: "Lint (Biome)" },
  { id: "test", title: "Tests (root Vitest projects)" },
  { id: "build", title: "Build" },
  { id: "self-update", title: "CLI self-update against a local fake registry" },
  { id: "packed-cli", title: "Install the packed CLI tarball and run it" },
];
const QUICK = ["install", "typecheck", "lint", "test"];

/** The steps to run for these command-line arguments, in pipeline order. Throws on a bad id. */
export function selectSteps(argv, steps = STEPS) {
  const ids = steps.map((s) => s.id);
  const list = (name) => {
    const i = argv.indexOf(name);
    if (i === -1) return null;
    const value = argv[i + 1];
    if (!value || value.startsWith("--")) throw new Error(`${name} needs a value`);
    const names = value
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    for (const n of names) {
      if (!ids.includes(n)) throw new Error(`Unknown step "${n}". Steps: ${ids.join(", ")}`);
    }
    return names;
  };
  const only = list("--only");
  const skip = list("--skip") ?? [];
  const from = list("--from");
  let chosen = only ?? (argv.includes("--quick") ? QUICK : ids);
  if (from) chosen = chosen.filter((id) => ids.indexOf(id) >= ids.indexOf(from[0]));
  return steps.filter((s) => chosen.includes(s.id) && !skip.includes(s.id));
}

/** Quote one argument for cmd.exe (Windows runs `.cmd` shims such as pnpm and npm through it). */
function quote(arg) {
  return /^[\w@%+=:,./\\-]+$/.test(arg) ? arg : `"${arg.replaceAll('"', '\\"')}"`;
}

/** Run a command to completion, streaming its output. Returns its exit code. */
function run(cmd, args, opts = {}) {
  console.log(`\n$ ${[cmd, ...args].join(" ")}${opts.cwd ? `   (in ${opts.cwd})` : ""}`);
  const result = WIN
    ? spawnSync([cmd, ...args].map(quote).join(" "), { stdio: "inherit", shell: true, ...opts })
    : spawnSync(cmd, args, { stdio: "inherit", ...opts });
  if (result.error) throw result.error;
  return result.status ?? 1;
}

/** Run a command and return its output; throws when it fails. */
function capture(cmd, args, opts = {}) {
  const result = WIN
    ? spawnSync([cmd, ...args].map(quote).join(" "), { encoding: "utf8", shell: true, ...opts })
    : spawnSync(cmd, args, { encoding: "utf8", ...opts });
  if (result.error) throw result.error;
  return { code: result.status ?? 1, out: `${result.stdout ?? ""}${result.stderr ?? ""}` };
}

function check(ok, message) {
  if (!ok) throw new Error(message);
}

/** Every file under `dir` whose text matches `pattern` (binary-safe enough for a tarball). */
function filesMatching(dir, pattern) {
  const hits = [];
  for (const entry of readdirSync(dir, { recursive: true })) {
    const file = join(dir, String(entry));
    if (!statSync(file).isFile()) continue;
    if (pattern.test(readFileSync(file, "latin1"))) hits.push(file);
  }
  return hits;
}

async function waitForHealth(url, seconds) {
  for (let i = 0; i < seconds; i++) {
    try {
      const res = await fetch(url);
      if (res.ok) return await res.text();
    } catch {
      // Not listening yet.
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
  return null;
}

/** The CI's "Install the packed tarball and run it" step, without bash. */
async function packedCli(port) {
  const work = mkdtempSync(join(tmpdir(), "agent-rishi-verify-"));
  try {
    check(
      run("npm", ["pack", "--pack-destination", work], { cwd: join(ROOT, "apps", "cli") }) === 0,
      "npm pack failed",
    );
    const tgz = readdirSync(work).find((f) => /^agent-rishi-.*\.tgz$/.test(f));
    check(tgz, "npm pack wrote no agent-rishi-*.tgz");
    const unpacked = join(work, "tarball");
    mkdirSync(unpacked);
    check(
      run("tar", ["xzf", join(work, tgz), "-C", unpacked]) === 0,
      "could not unpack the tarball",
    );
    check(
      filesMatching(unpacked, /Anthropic PBC|Native CLI binary for/).length === 0,
      "the tarball contains Claude Agent SDK code",
    );
    const notices = join(unpacked, "package", "dist", "THIRD-PARTY-NOTICES.txt");
    check(
      !readFileSync(notices, "utf8").includes("claude-agent-sdk@"),
      "THIRD-PARTY-NOTICES lists the Claude Agent SDK as bundled",
    );

    const install = join(work, "install-check");
    mkdirSync(install);
    check(capture("npm", ["init", "-y"], { cwd: install }).code === 0, "npm init failed");
    check(
      run("npm", ["install", join(work, tgz)], { cwd: install }) === 0,
      "npm install of the tarball failed",
    );
    check(
      !existsSync(join(install, "node_modules", "@anthropic-ai")),
      "the packed CLI installed @anthropic-ai packages",
    );
    console.log(`node_modules: ${readdirSync(join(install, "node_modules")).join(", ")}`);

    const bin = join(install, "node_modules", ".bin", WIN ? "agent-rishi.cmd" : "agent-rishi");
    const home = join(work, "agent-rishi-home");
    const cli = (args) => capture(bin, args, { cwd: install });
    const version = cli(["--version"]);
    console.log(`agent-rishi --version: ${version.out.trim()}`);
    check(version.code === 0, "agent-rishi --version failed");

    const doctor = cli(["doctor", "--home", home]).out;
    console.log(doctor);
    check(/ok {2}Terminals/.test(doctor), "doctor: Terminals is not ok");
    if (!/ok {2}Keychain/.test(doctor)) console.warn("warning: the keychain module did not load");
    check(
      /-- {2}Claude Code support/.test(doctor),
      "doctor: expected Claude Code support to be absent before install",
    );

    const installed = cli(["doctor", "--install", "--home", home]).out;
    console.log(installed);
    check(
      /ok {2}Claude Code support {2}SDK /.test(installed),
      "doctor --install: Claude Code support SDK did not install",
    );
    const sdk = readdirSync(join(home, "deps", "node_modules", "@anthropic-ai"));
    check(
      sdk.join() === "claude-agent-sdk",
      `on-demand install added more than the SDK: ${sdk.join(", ")}`,
    );

    const server = spawn(
      WIN ? `${quote(bin)} --home ${quote(home)} --port ${port} --no-open` : bin,
      WIN ? [] : ["--home", home, "--port", String(port), "--no-open"],
      {
        cwd: install,
        shell: WIN,
        stdio: "ignore",
        env: { ...process.env, AGENT_RISHI_UPDATE_CHECK: "0" },
      },
    );
    try {
      const health = await waitForHealth(`http://127.0.0.1:${port}/api/health`, 60);
      console.log(`health: ${health}`);
      check(health?.includes('"ok":true'), "the server did not report healthy within 60 s");
      const token = readFileSync(join(home, "install-token"), "utf8").trim();
      const index = await (
        await fetch(`http://127.0.0.1:${port}/`, {
          headers: { cookie: `agent_rishi_token_${port}=${token}` },
        })
      ).text();
      check(index.includes("<title>Agent Rishi"), "the web UI was not served");
      const templates = await (
        await fetch(`http://127.0.0.1:${port}/api/automations/templates`, {
          headers: { authorization: `Bearer ${token}` },
        })
      ).text();
      check(templates.includes("security-audit"), "the automation templates were not served");
    } finally {
      cli(["stop", "--home", home]);
      server.kill();
    }
  } finally {
    rmSync(work, { recursive: true, force: true, maxRetries: 3 });
  }
}

async function runStep(id, port) {
  const pnpm = (...args) => run("pnpm", args, { cwd: ROOT });
  switch (id) {
    case "install":
      return check(pnpm("install", "--frozen-lockfile") === 0, "pnpm install failed");
    case "typecheck":
      return check(pnpm("typecheck") === 0, "typecheck failed");
    case "lint":
      return check(pnpm("lint") === 0, "lint failed");
    case "test":
      return check(pnpm("test") === 0, "tests failed");
    case "build":
      return check(pnpm("build") === 0, "build failed");
    case "self-update":
      return check(
        run("pnpm", ["exec", "vitest", "run", "apps/cli/test/self-update.integration.test.ts"], {
          cwd: ROOT,
          env: { ...process.env, AGENT_RISHI_REQUIRE_CLI_DIST: "1" },
        }) === 0,
        "self-update integration test failed",
      );
    case "packed-cli":
      return packedCli(port);
  }
}

async function main(argv) {
  const steps = selectSteps(argv);
  const portIndex = argv.indexOf("--port");
  const port = portIndex === -1 ? 4791 : Number(argv[portIndex + 1]);
  const keepGoing = argv.includes("--keep-going");
  const results = [];
  for (const step of steps) {
    console.log(`\n=== ${step.id}: ${step.title} ===`);
    const started = Date.now();
    try {
      await runStep(step.id, port);
      results.push({ ...step, ok: true, seconds: (Date.now() - started) / 1000 });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      results.push({ ...step, ok: false, seconds: (Date.now() - started) / 1000, message });
      if (!keepGoing) break;
    }
  }
  console.log("\n=== verify summary ===");
  for (const r of results) {
    console.log(
      `${r.ok ? "PASS" : "FAIL"}  ${r.id.padEnd(12)} ${r.seconds.toFixed(0).padStart(5)} s${r.ok ? "" : `  ${r.message}`}`,
    );
  }
  for (const s of steps.filter((s) => !results.some((r) => r.id === s.id))) {
    console.log(`SKIP  ${s.id}`);
  }
  const failed = results.some((r) => !r.ok);
  console.log(failed ? "\nverify: FAILED" : `\nverify: passed (${results.length} steps)`);
  return failed ? 1 : 0;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (error) => {
      console.error(error instanceof Error ? error.message : error);
      process.exit(2);
    },
  );
}
