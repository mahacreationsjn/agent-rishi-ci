#!/usr/bin/env node
/**
 * Release Agent Rishi from a maintainer's machine, without hosted CI:
 *
 *   node scripts/release/local-release.mjs <patch|minor|major> [options]
 *
 *   --dry-run        check, verify and build the installer at the current version; change,
 *                    commit, tag and upload nothing, and print what a release would do
 *   --skip-verify    don't run `pnpm verify` first (only after running it yourself)
 *   --publish        publish the GitHub Release; by default it is created as a draft that only
 *                    repository members see, to be published from GitHub when ready
 *   --upload-only vX.Y.Z
 *                    build this machine's installers for an existing release and add them
 *                    (e.g. Linux after the Windows release); no version change, no tag
 *
 * A release: checks (on main, clean, up to date, tag free, `gh` signed in, Windows paths short
 * enough for NSIS) → `pnpm verify` → bump-version.mjs (versions + CHANGELOG from changes/) →
 * `chore(release): X.Y.Z` commit → build and package this OS's installers → SHA256SUMS →
 * tag vX.Y.Z → push main and the tag → GitHub Release with the installers, update metadata
 * and checksums. If the build fails, the release commit is undone (the tree was clean, so
 * nothing else is lost). Nothing is published to npm.
 */
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { BUMPS, bumpRepository, nextVersion, today } from "./bump-version.mjs";

const ROOT = resolve(fileURLToPath(new URL("../..", import.meta.url)));
const WIN = process.platform === "win32";
const RELEASE_DIR = join(ROOT, "apps", "desktop", "release");

/** Parse the command line. Throws on a mistake, before anything runs. */
export function parseReleaseArgs(argv) {
  const opts = {
    bump: null,
    dryRun: argv.includes("--dry-run"),
    skipVerify: argv.includes("--skip-verify"),
    publish: argv.includes("--publish"),
    uploadOnly: null,
  };
  const known = new Set(["--dry-run", "--skip-verify", "--publish", "--upload-only"]);
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--upload-only") {
      const tag = argv[++i];
      if (!tag || !/^v\d+\.\d+\.\d+$/.test(tag)) {
        throw new Error("--upload-only needs a tag like v0.7.14");
      }
      opts.uploadOnly = tag;
    } else if (arg.startsWith("--")) {
      if (!known.has(arg)) throw new Error(`Unknown option ${arg}`);
    } else if (opts.bump === null) {
      if (!BUMPS.includes(arg)) throw new Error(`Expected ${BUMPS.join(", ")}, got "${arg}"`);
      opts.bump = arg;
    } else {
      throw new Error(`Unexpected argument "${arg}"`);
    }
  }
  if (opts.uploadOnly && opts.bump) throw new Error("--upload-only takes no bump");
  if (opts.uploadOnly && opts.publish) throw new Error("--upload-only can't --publish");
  if (!opts.uploadOnly && !opts.bump) {
    throw new Error(`Usage: local-release.mjs <${BUMPS.join("|")}> [--dry-run] [--publish]`);
  }
  return opts;
}

/** The `## [version]` section of CHANGELOG.md, without its heading: the release notes. */
export function changelogSection(changelog, version) {
  const lines = changelog.split(/\r?\n/);
  const start = lines.findIndex((l) => l.startsWith(`## [${version}]`));
  if (start === -1) throw new Error(`CHANGELOG.md has no section for ${version}`);
  const end = lines.findIndex((l, i) => i > start && /^## \[/.test(l));
  return lines
    .slice(start + 1, end === -1 ? undefined : end)
    .join("\n")
    .trim();
}

/**
 * The files of `release/` a GitHub Release carries for `version`: installers, blockmaps and the
 * updater's `latest*.yml`. Not the unpacked folders, `builder-debug.yml` or stale versions.
 */
export function releaseArtifacts(files, version) {
  const v = version.replaceAll(".", "\\.");
  const installer = new RegExp(
    `^(Agent Rishi-Setup-${v}\\.exe|Agent Rishi-${v}-[\\w]+\\.(dmg|zip|AppImage)|agent_rishi_${v}_[\\w]+\\.deb)(\\.blockmap)?$`,
  );
  return files.filter((f) => installer.test(f) || /^latest(-[\w]+)?\.yml$/.test(f)).sort();
}

/** `SHA256SUMS` text for `files` in `dir`, in the `sha256sum` format. */
export function sha256sums(dir, files) {
  return files
    .map(
      (f) =>
        `${createHash("sha256")
          .update(readFileSync(join(dir, f)))
          .digest("hex")}  ${f}`,
    )
    .join("\n")
    .concat("\n");
}

/** Problems that stop a release, from the repository's state. Empty when it may go ahead. */
export function preflightProblems(state) {
  const problems = [];
  if (state.branch !== "main") problems.push(`on branch "${state.branch}", not main`);
  if (state.dirty) problems.push("the working tree has uncommitted changes");
  if (state.behind > 0) problems.push(`main is ${state.behind} commit(s) behind origin/main`);
  if (state.ahead > 0) problems.push(`main has ${state.ahead} unpushed commit(s)`);
  if (state.tagExists) problems.push(`tag ${state.tag} already exists`);
  if (!state.ghSignedIn) problems.push("`gh` is not signed in (run `gh auth login`)");
  if (state.nsisProblem) problems.push(state.nsisProblem);
  return problems;
}

function git(...args) {
  return execFileSync("git", args, { cwd: ROOT, encoding: "utf8" }).trim();
}

/** Run a command (`.cmd` shims such as pnpm go through the shell on Windows). */
function run(cmd, args, opts = {}) {
  console.log(`\n$ ${[cmd, ...args].join(" ")}`);
  const quote = (a) => (/^[\w@%+=:,./\\-]+$/.test(a) ? a : `"${a.replaceAll('"', '\\"')}"`);
  const result = WIN
    ? spawnSync([cmd, ...args].map(quote).join(" "), {
        cwd: ROOT,
        stdio: "inherit",
        shell: true,
        ...opts,
      })
    : spawnSync(cmd, args, { cwd: ROOT, stdio: "inherit", ...opts });
  if (result.status !== 0) throw new Error(`${cmd} ${args.join(" ")} failed`);
}

async function nsisProblem() {
  if (!WIN) return null;
  const { assertNsisPathsFit } = await import(
    new URL("../../apps/desktop/scripts/nsis-paths.mjs", import.meta.url).href
  );
  try {
    assertNsisPathsFit(join(ROOT, "apps", "desktop", "package.json"));
    return null;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

async function readState(tag) {
  git("fetch", "--quiet", "origin", "main", "--tags");
  const [behind, ahead] = git("rev-list", "--left-right", "--count", "origin/main...HEAD")
    .split(/\s+/)
    .map(Number);
  const gh = spawnSync("gh", ["auth", "status"], { encoding: "utf8", shell: WIN });
  return {
    branch: git("branch", "--show-current"),
    dirty: git("status", "--porcelain") !== "",
    behind,
    ahead,
    tag,
    tagExists: tag ? git("tag", "--list", tag) !== "" : false,
    ghSignedIn: gh.status === 0,
    nsisProblem: await nsisProblem(),
  };
}

/** Build this OS's installers into apps/desktop/release; returns the files to upload. */
function buildInstallers(version) {
  rmSync(RELEASE_DIR, { recursive: true, force: true, maxRetries: 3 });
  run("pnpm", ["build"]);
  // Straight to the script: through `pnpm ... package --` the `--` reaches its strict parseArgs.
  run("node", ["scripts/package.mjs", "--publish", "never"], {
    cwd: join(ROOT, "apps", "desktop"),
  });
  const files = releaseArtifacts(readdirSync(RELEASE_DIR), version);
  if (!files.some((f) => !f.endsWith(".yml") && !f.endsWith(".blockmap"))) {
    throw new Error(`no installer for ${version} in ${RELEASE_DIR}`);
  }
  const sums = `SHA256SUMS-${process.platform}.txt`;
  writeFileSync(join(RELEASE_DIR, sums), sha256sums(RELEASE_DIR, files));
  return [...files, sums];
}

async function main(argv) {
  const opts = parseReleaseArgs(argv);
  const current = JSON.parse(readFileSync(join(ROOT, "apps/cli/package.json"), "utf8")).version;

  if (opts.uploadOnly) {
    const version = opts.uploadOnly.slice(1);
    if (version !== current) {
      throw new Error(`check out ${opts.uploadOnly} first (this tree is ${current})`);
    }
    const problem = await nsisProblem();
    if (problem) throw new Error(problem);
    const files = buildInstallers(version);
    run("gh", [
      "release",
      "upload",
      opts.uploadOnly,
      "--clobber",
      ...files.map((f) => join(RELEASE_DIR, f)),
    ]);
    console.log(`\nAdded ${files.length} file(s) to ${opts.uploadOnly}.`);
    return;
  }

  const version = nextVersion(current, opts.bump);
  const tag = `v${version}`;
  const problems = preflightProblems(await readState(tag));
  if (problems.length && !opts.dryRun) {
    throw new Error(`Can't release ${tag}:\n  - ${problems.join("\n  - ")}`);
  }
  if (problems.length) console.warn(`Would refuse to release:\n  - ${problems.join("\n  - ")}`);
  if (!opts.skipVerify) run("pnpm", ["verify"]);

  if (opts.dryRun) {
    const preview = bumpRepository(ROOT, opts.bump, today(), { dryRun: true });
    const files = buildInstallers(current);
    console.log(
      [
        "",
        `Dry run: nothing was changed, committed, tagged or uploaded.`,
        `A release would make ${tag} (from ${current}) with these notes:`,
        "",
        preview.notes,
        "",
        `It would upload (built here at ${current}; a release builds them at ${version}):`,
        ...files.map((f) => `  ${f}`),
        `as a ${opts.publish ? "published" : "draft"} GitHub Release.`,
      ].join("\n"),
    );
    return;
  }

  const before = git("rev-parse", "HEAD");
  const bumped = bumpRepository(ROOT, opts.bump, today());
  if (bumped.fragments.length)
    git("rm", "--cached", "--quiet", "--ignore-unmatch", "--", ...bumped.fragments);
  git(
    "add",
    "apps/cli/package.json",
    "apps/desktop/package.json",
    "packages/contracts/src/version.ts",
    "CHANGELOG.md",
  );
  git("commit", "--quiet", "-m", `chore(release): ${version}`);
  let files;
  try {
    files = buildInstallers(version);
  } catch (error) {
    git("reset", "--hard", "--quiet", before);
    throw new Error(
      `${error instanceof Error ? error.message : error}\nThe release commit was undone.`,
    );
  }
  git("tag", "-a", tag, "-m", `Agent Rishi ${version}`);
  run("git", ["push", "origin", "HEAD:main", tag]);
  const notes = join(RELEASE_DIR, "release-notes.md");
  writeFileSync(
    notes,
    `${changelogSection(readFileSync(join(ROOT, "CHANGELOG.md"), "utf8"), version)}\n`,
  );
  run("gh", [
    "release",
    "create",
    tag,
    "--title",
    `Agent Rishi ${version}`,
    "--notes-file",
    notes,
    ...(opts.publish ? [] : ["--draft"]),
    ...files.map((f) => join(RELEASE_DIR, f)),
  ]);
  console.log(
    `\nReleased ${tag}${opts.publish ? "" : " as a draft (publish it on GitHub when ready)"}.`,
  );
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch((error) => {
    console.error(`\nlocal-release: ${error instanceof Error ? error.message : error}`);
    process.exit(1);
  });
}
