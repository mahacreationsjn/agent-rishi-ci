// The NSIS compiler (makensis) can't open files past Windows' 260-character MAX_PATH. electron-builder
// hands it the templates inside the app-builder-lib package, and pnpm resolves that package
// through a long `node_modules/.pnpm/app-builder-lib@<version>_<hash>/...` folder. From a deeply
// nested checkout (a temp or worktree folder) the build then fails late, after staging and
// packing, with only `!include: could not open file: ...StdUtils.nsh`. Check up front instead.
import { readdirSync, realpathSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";

/** Longest path makensis opens without failing: MAX_PATH (260) less the terminating NUL. */
export const NSIS_MAX_PATH = 259;

/** The longest path in `files`, and whether it is too long for makensis. */
export function nsisPathProblem(files, limit = NSIS_MAX_PATH) {
  let longest = "";
  for (const file of files) if (file.length > longest.length) longest = file;
  return longest.length > limit ? { longest, length: longest.length, limit } : null;
}

/** Every file under `dir` (recursive), as absolute paths. */
function filesUnder(dir) {
  return readdirSync(dir, { recursive: true })
    .map((entry) => join(dir, String(entry)))
    .filter((file) => statSync(file).isFile());
}

/**
 * The NSIS template files electron-builder would hand makensis, at their real (symlink-resolved)
 * location, given the package that depends on electron-builder.
 */
export function nsisTemplateFiles(fromPackageJson) {
  const fromBuilder = createRequire(
    createRequire(fromPackageJson).resolve("electron-builder/package.json"),
  );
  const lib = realpathSync(dirname(fromBuilder.resolve("app-builder-lib/package.json")));
  return filesUnder(join(lib, "templates", "nsis"));
}

/** Throw a clear error before packaging when makensis would fail on a too-long path. */
export function assertNsisPathsFit(fromPackageJson) {
  const problem = nsisPathProblem(nsisTemplateFiles(fromPackageJson));
  if (!problem) return;
  const extra = problem.length - problem.limit;
  throw new Error(
    [
      `The Windows installer can't be built from this folder: NSIS can't open paths over ${problem.limit} characters,`,
      `and electron-builder's templates are ${problem.length} (${extra} too many):`,
      `  ${problem.longest}`,
      "Clone or move the repository to a shorter folder (for example C:\\src\\agent-rishi), run",
      "`pnpm install`, and package again. (A `subst` drive doesn't help: pnpm links resolve to the long path.)",
    ].join("\n"),
  );
}
