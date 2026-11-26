import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

/**
 * The runner image's source (`docs/remote-runners.md` §5.2): the Dockerfile shipped in the
 * `agent-rishi` package and the package's own bundle. The image is built locally from them on
 * first use, never pulled from a registry.
 */
export interface ImageSource {
  /** The bundle folder: `runner.js`, `cli.js` and their chunks. */
  distDir: string;
  dockerfile: string;
  /** The package's `package.json`, for its version and runtime dependencies. */
  packageJson: string;
}

/**
 * Where the image's source is: next to this module in the published package (`dist/`, with the
 * Dockerfile in `dist/docker`), or `apps/cli` in a checkout once `pnpm build` made its bundle.
 * Null when neither has it (a checkout that was never built, or the desktop app, which ships no
 * CLI bundle).
 */
export function findImageSource(here: string = import.meta.dirname): ImageSource | null {
  const candidates: ImageSource[] = [
    {
      distDir: here,
      dockerfile: join(here, "docker", "Dockerfile"),
      packageJson: resolve(here, "../package.json"),
    },
    {
      distDir: resolve(here, "../../../../cli/dist"),
      dockerfile: resolve(here, "../../../../cli/docker/Dockerfile"),
      packageJson: resolve(here, "../../../../cli/package.json"),
    },
  ];
  return (
    candidates.find(
      (c) =>
        existsSync(join(c.distDir, "runner.js")) &&
        existsSync(join(c.distDir, "cli.js")) &&
        existsSync(c.dockerfile) &&
        existsSync(c.packageJson),
    ) ?? null
  );
}

/** The bundle files the image needs: the runner, the CLI (for `runner-link`) and their chunks. */
function bundleFiles(distDir: string): string[] {
  return readdirSync(distDir, { withFileTypes: true })
    .filter((e) => e.isFile() && (e.name.endsWith(".js") || e.name === "THIRD-PARTY-NOTICES.txt"))
    .map((e) => e.name)
    .sort();
}

/**
 * The `package.json` the image installs: the package's name, version and runtime dependencies
 * only (native modules and playwright-core), without its workspace-only dev dependencies.
 */
export function imagePackageJson(pkg: Record<string, unknown>, version: string): string {
  const dependencies =
    pkg.dependencies && typeof pkg.dependencies === "object" ? pkg.dependencies : {};
  return `${JSON.stringify(
    { name: "agent-rishi", version, private: true, type: "module", dependencies },
    null,
    2,
  )}\n`;
}

/** One file of the build context, by its path inside the context. */
interface ContextFile {
  path: string;
  data: Buffer;
}

/** The build context: the Dockerfile, `agent-rishi/package.json` and `agent-rishi/dist/*`. */
function contextFiles(source: ImageSource, version: string): ContextFile[] {
  const pkg = JSON.parse(readFileSync(source.packageJson, "utf8")) as Record<string, unknown>;
  return [
    { path: "Dockerfile", data: readFileSync(source.dockerfile) },
    { path: "agent-rishi/package.json", data: Buffer.from(imagePackageJson(pkg, version)) },
    ...bundleFiles(source.distDir).map((name) => ({
      path: `agent-rishi/dist/${name}`,
      data: readFileSync(join(source.distDir, name)),
    })),
  ];
}

/**
 * The context's content hash, the image's `agent-rishi.build` label: a changed bundle (a new build
 * from a checkout) makes a new image under the same version.
 */
export function contextHash(source: ImageSource, version: string): string {
  const hash = createHash("sha256");
  for (const file of contextFiles(source, version)) {
    hash.update(`${file.path}\0`);
    hash.update(file.data);
    hash.update("\0");
  }
  return hash.digest("hex").slice(0, 16);
}

/** Lay out the build context in `dir` (an empty folder of its own). */
export function writeContext(source: ImageSource, dir: string, version: string): void {
  for (const file of contextFiles(source, version)) {
    const target = join(dir, file.path);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, file.data);
  }
}
