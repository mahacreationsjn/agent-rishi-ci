// Makes sure the packed desktop app has every runtime dependency (§17). Used by the
// electron-builder config's afterPack hook.
//
// scripts/package.mjs installs the runtime dependencies into the stage (.stage/app) with npm,
// but electron-builder collects the app's node_modules on its own, and in this pnpm workspace
// it left packages out (playwright-core, so the runner could not start; the keychain binary
// for an arch other than the build machine's). So after packing: copy every staged package
// the app is missing (only those meant for the target platform and arch), then fail the build
// if any dependency of the app still doesn't resolve inside the packed app.

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { cp, mkdir } from "node:fs/promises";
import { join, posix } from "node:path";

/**
 * The packages directly in a node_modules folder, scoped ones as `@scope/name`. Folders without
 * a package.json (`.bin`, leftovers) are skipped.
 */
export function listPackages(nodeModules) {
  const names = [];
  for (const entry of safeReaddir(nodeModules)) {
    if (!entry.isDirectory() || entry.name.startsWith(".")) continue;
    if (entry.name.startsWith("@")) {
      for (const scoped of safeReaddir(join(nodeModules, entry.name))) {
        const name = `${entry.name}/${scoped.name}`;
        if (scoped.isDirectory() && readManifest(join(nodeModules, name))) names.push(name);
      }
    } else if (readManifest(join(nodeModules, entry.name))) {
      names.push(entry.name);
    }
  }
  return names.sort();
}

function safeReaddir(dir) {
  try {
    return readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
}

/** A package folder's package.json, or undefined when there is none (or it doesn't parse). */
function readManifest(dir) {
  try {
    return JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
  } catch {
    return undefined;
  }
}

/** Whether a package.json `os` / `cpu` / `libc` list (with `!` exclusions) allows a value. */
function allows(list, values) {
  if (!Array.isArray(list) || list.length === 0) return true;
  const excluded = list.filter((v) => v.startsWith("!")).map((v) => v.slice(1));
  const included = list.filter((v) => !v.startsWith("!"));
  return values.some(
    (value) => !excluded.includes(value) && (included.length === 0 || included.includes(value)),
  );
}

/**
 * Whether a package is meant for the target: its `os`, `cpu` and `libc` fields (as npm reads
 * them) allow `target.platform` (`win32`, `darwin`, `linux`) and `target.arch` (`x64`,
 * `arm64`, ...; `universal` allows both macOS arches). Linux builds are glibc builds.
 */
export function isForTarget(manifest, target) {
  const arches = target.arch === "universal" ? ["x64", "arm64"] : [target.arch];
  return (
    allows(manifest.os, [target.platform]) &&
    allows(manifest.cpu, arches) &&
    (target.platform !== "linux" || allows(manifest.libc, ["glibc"]))
  );
}

/**
 * The packages in the stage's node_modules (`stageModules`) that the packed app's node_modules
 * (`appModules`) lacks, leaving out those built for another platform or arch (the stage holds
 * the keychain binary for every target arch).
 */
export function packagesToCopy(stageModules, appModules, target) {
  return listPackages(stageModules).filter(
    (name) =>
      !existsSync(join(appModules, ...name.split("/"), "package.json")) &&
      isForTarget(readManifest(join(stageModules, ...name.split("/"))), target),
  );
}

/**
 * Where Node.js finds package `name` when required from the package at `from` (a path relative
 * to `root` like `node_modules/a`, or `""` for the app itself): `from/node_modules/name`, then
 * the same in each parent folder. Returns the relative path, or undefined.
 */
function resolvePackage(root, from, name) {
  let dir = from;
  for (;;) {
    if (posix.basename(dir) !== "node_modules") {
      const candidate = posix.join(dir, "node_modules", name);
      if (existsSync(join(root, ...candidate.split("/"), "package.json"))) return candidate;
    }
    if (dir === "" || dir === ".") return undefined;
    dir = posix.dirname(dir);
    if (dir === ".") dir = "";
  }
}

/**
 * The dependencies of the app that don't resolve in the packed app (`appDir`), as
 * `name (needed by requirer)`. Walks the stage (`stageDir`, where npm installed them): the
 * stage's package.json `dependencies` plus `extraRequired`, then each package's
 * `dependencies`, and its optional and peer dependencies that npm installed in the stage for
 * this target. Each one must resolve from the same place in the packed app.
 */
export function missingDependencies(stageDir, appDir, target, extraRequired = []) {
  const missing = [];
  const seen = new Set();
  const queue = [{ rel: "", extra: extraRequired }];
  while (queue.length) {
    const { rel, extra = [] } = queue.shift();
    if (seen.has(rel)) continue;
    seen.add(rel);
    const manifest = readManifest(join(stageDir, ...rel.split("/").filter(Boolean))) ?? {};
    const requirer = rel === "" ? "the app" : (manifest.name ?? rel);
    const edges = [
      ...Object.keys(manifest.dependencies ?? {}).map((name) => ({ name, required: true })),
      ...extra.map((name) => ({ name, required: true })),
      ...Object.keys({ ...manifest.optionalDependencies, ...manifest.peerDependencies }).map(
        (name) => ({ name, required: false }),
      ),
    ];
    for (const { name, required } of edges) {
      const staged = resolvePackage(stageDir, rel, name);
      if (!required) {
        // Optional and peer dependencies count when npm installed them for this target.
        if (!staged) continue;
        const stagedManifest = readManifest(join(stageDir, ...staged.split("/")));
        if (!stagedManifest || !isForTarget(stagedManifest, target)) continue;
      }
      if (!resolvePackage(appDir, rel, name)) {
        if (!missing.some((entry) => entry.startsWith(`${name} `))) {
          missing.push(`${name} (needed by ${requirer})`);
        }
        continue;
      }
      if (staged) queue.push({ rel: staged });
    }
  }
  return missing;
}

/**
 * Copies the staged packages the packed app lacks into it (see `packagesToCopy`), then throws
 * if a dependency is still missing (see `missingDependencies`). `stageDir` and `appDir` are the
 * folders holding package.json and node_modules. Returns the copied package names.
 */
export async function packStagedDependencies({
  stageDir,
  appDir,
  target,
  extraRequired = [],
  log = console.log,
}) {
  const stageModules = join(stageDir, "node_modules");
  const appModules = join(appDir, "node_modules");
  const copy = packagesToCopy(stageModules, appModules, target);
  if (copy.length) await mkdir(appModules, { recursive: true });
  for (const name of copy) {
    await cp(join(stageModules, ...name.split("/")), join(appModules, ...name.split("/")), {
      recursive: true,
      verbatimSymlinks: true,
    });
  }
  if (copy.length) {
    log(`  • copied ${copy.length} staged package(s) missing from the app: ${copy.join(", ")}`);
  }
  const missing = missingDependencies(stageDir, appDir, target, extraRequired);
  if (missing.length) {
    throw new Error(
      `The packed app is missing ${missing.length} runtime dependenc${missing.length === 1 ? "y" : "ies"} ` +
        `(not in the stage ${stageModules} either, or not for ${target.platform}-${target.arch}): ` +
        missing.join(", "),
    );
  }
  log(`  • every runtime dependency is in the packed app (${appModules})`);
  return copy;
}
