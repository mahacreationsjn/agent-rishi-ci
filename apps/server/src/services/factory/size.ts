import type { FactoryTuning } from "@agent-rishi/contracts";
import type { FactoryPr } from "./github-port";

/**
 * The size merge check (§10.1 step 4) counts code someone has to review. Lockfiles and
 * generated or vendored files are left out: a new dependency can add thousands of lockfile
 * lines, and a scaffold copies in UI components nobody reviews line by line.
 */

const LOCKFILES = new Set([
  "package-lock.json",
  "npm-shrinkwrap.json",
  "pnpm-lock.yaml",
  "yarn.lock",
  "bun.lock",
  "bun.lockb",
  "deno.lock",
  "cargo.lock",
  "poetry.lock",
  "uv.lock",
  "pipfile.lock",
  "pdm.lock",
  "gemfile.lock",
  "composer.lock",
  "go.sum",
  "flake.lock",
  "packages.lock.json",
  "pubspec.lock",
  "mix.lock",
  "podfile.lock",
  "package.resolved",
]);

/** Folders whose contents are built, installed or vendored rather than written. */
const GENERATED_DIRS = [
  "node_modules",
  "vendor",
  "dist",
  "build",
  ".next",
  ".nuxt",
  ".svelte-kit",
  "coverage",
  "__snapshots__",
  "__generated__",
];

/** File names that mark generated output. */
const GENERATED_NAME = /\.(min\.(js|css)|map|snap|lock)$|\.(gen|generated)\.[a-z]+$/i;

/**
 * drizzle-kit's schema snapshots, thousands of lines each that `drizzle-kit generate` writes
 * beside a migration: `<out>/<14-digit timestamp>_<name>/snapshot.json`, or
 * `<out>/meta/0003_snapshot.json` before drizzle-kit 1.0. The migration's SQL still counts.
 */
function isDrizzleSnapshot(dirs: string[], name: string): boolean {
  const parent = dirs.at(-1) ?? "";
  return (
    (name === "snapshot.json" && /^\d{14}_/.test(parent)) ||
    (parent === "meta" && /^\d{4}_snapshot\.json$/.test(name))
  );
}

/** True for a package manager's lockfile, in any folder: the known names, and any `*.lock`. */
export function isLockfile(path: string): boolean {
  const name = (path.replace(/\\/g, "/").split("/").at(-1) ?? "").toLowerCase();
  return LOCKFILES.has(name) || name.endsWith(".lock");
}

/** True for files the size check doesn't count (lockfiles, generated or vendored files). */
export function isUncountedFile(path: string): boolean {
  const parts = path.replace(/\\/g, "/").split("/");
  const name = (parts.at(-1) ?? "").toLowerCase();
  if (LOCKFILES.has(name) || GENERATED_NAME.test(name)) return true;
  const dirs = parts.slice(0, -1);
  if (dirs.some((d) => GENERATED_DIRS.includes(d))) return true;
  if (isDrizzleSnapshot(dirs, name)) return true;
  // shadcn/ui components are copied in by its CLI (`components/ui/...`).
  return dirs.some((d, i) => d === "components" && dirs[i + 1] === "ui");
}

export interface ChangeSize {
  lines: number;
  files: number;
  /** Files left out of the count. */
  uncounted: number;
}

/** Lines and files the size check counts for a PR. */
export function changeSize(pr: FactoryPr): ChangeSize {
  if (!pr.fileLines) {
    // No per-file numbers: count everything.
    return { lines: pr.additions + pr.deletions, files: pr.files.length, uncounted: 0 };
  }
  let lines = 0;
  let files = 0;
  for (const f of pr.fileLines) {
    // A file moved out of counted code still counts, wherever it went (`vendor/`, `dist/`).
    if (isUncountedFile(f.path) && (!f.previousPath || isUncountedFile(f.previousPath))) continue;
    lines += f.lines;
    files += 1;
  }
  return { lines, files, uncounted: pr.fileLines.length - files };
}

/** The size limits as a phrase ("5,000 lines", "no limit"). */
export function sizeLimitText(tuning: Pick<FactoryTuning, "maxChangedLines" | "maxChangedFiles">) {
  const parts = [
    tuning.maxChangedLines !== null ? `${tuning.maxChangedLines.toLocaleString("en")} lines` : "",
    tuning.maxChangedFiles !== null ? `${tuning.maxChangedFiles.toLocaleString("en")} files` : "",
  ].filter(Boolean);
  return parts.length > 0 ? parts.join(", ") : "no limit";
}

/** True when the change is over a limit that is set. */
export function overSizeLimit(
  size: ChangeSize,
  tuning: Pick<FactoryTuning, "maxChangedLines" | "maxChangedFiles">,
): boolean {
  return (
    (tuning.maxChangedLines !== null && size.lines > tuning.maxChangedLines) ||
    (tuning.maxChangedFiles !== null && size.files > tuning.maxChangedFiles)
  );
}
