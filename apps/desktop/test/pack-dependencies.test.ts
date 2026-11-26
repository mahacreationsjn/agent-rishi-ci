import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

type Target = { platform: string; arch: string };
type PackDependencies = {
  packagesToCopy(stageModules: string, appModules: string, target: Target): string[];
  missingDependencies(
    stageDir: string,
    appDir: string,
    target: Target,
    extraRequired?: string[],
  ): string[];
  packStagedDependencies(options: {
    stageDir: string;
    appDir: string;
    target: Target;
    extraRequired?: string[];
    log?: (line: string) => void;
  }): Promise<string[]>;
};

async function load(): Promise<PackDependencies> {
  // A non-literal specifier: the module is plain JavaScript without type declarations.
  const file = "../pack-dependencies.mjs";
  return (await import(/* @vite-ignore */ file)) as PackDependencies;
}

const WIN_X64: Target = { platform: "win32", arch: "x64" };
const KEYRING_X64 = "@napi-rs/keyring-win32-x64-msvc";
const KEYRING_ARM64 = "@napi-rs/keyring-win32-arm64-msvc";

let dir: string;
let stage: string;
let app: string;

/** Writes a package.json at `root/node_modules/<name>` (or `root` itself when name is ""). */
function writePackage(root: string, name: string, manifest: Record<string, unknown> = {}) {
  const at = name ? join(root, "node_modules", ...name.split("/")) : root;
  mkdirSync(at, { recursive: true });
  writeFileSync(join(at, "package.json"), JSON.stringify({ name, version: "1.0.0", ...manifest }));
}

const keyringOptional = {
  [KEYRING_X64]: "1.0.0",
  [KEYRING_ARM64]: "1.0.0",
  "@napi-rs/keyring-darwin-arm64": "1.0.0",
};

/**
 * A stage as npm leaves it (the keychain binary installed for two arches), and a packed app
 * the way electron-builder left it in 0.7.10: no playwright-core, no keychain binary.
 */
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "pack-deps-"));
  stage = join(dir, "stage");
  app = join(dir, "app");
  const appManifest = {
    dependencies: { "@napi-rs/keyring": "^1", "node-pty": "1", "playwright-core": "1" },
  };
  for (const root of [stage, app]) {
    writePackage(root, "", appManifest);
    writePackage(root, "@napi-rs/keyring", { optionalDependencies: keyringOptional });
    writePackage(root, "node-pty", { dependencies: { "node-addon-api": "^7" } });
    writePackage(root, "node-addon-api");
  }
  writePackage(stage, "playwright-core");
  writePackage(stage, KEYRING_X64, { os: ["win32"], cpu: ["x64"] });
  writePackage(stage, KEYRING_ARM64, { os: ["win32"], cpu: ["arm64"] });
  mkdirSync(join(stage, "node_modules", ".bin"), { recursive: true });
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("packing the staged dependencies", () => {
  it("copies playwright-core and this arch's keychain binary, and nothing for other arches", async () => {
    const { packagesToCopy } = await load();
    expect(packagesToCopy(join(stage, "node_modules"), join(app, "node_modules"), WIN_X64)).toEqual(
      [KEYRING_X64, "playwright-core"],
    );
    expect(
      packagesToCopy(join(stage, "node_modules"), join(app, "node_modules"), {
        platform: "win32",
        arch: "arm64",
      }),
    ).toEqual([KEYRING_ARM64, "playwright-core"]);
  });

  it("reports what the packed app is missing", async () => {
    const { missingDependencies } = await load();
    expect(missingDependencies(stage, app, WIN_X64, [KEYRING_X64])).toEqual([
      "playwright-core (needed by the app)",
      `${KEYRING_X64} (needed by the app)`,
    ]);
  });

  it("fixes the packed app, which then has every dependency", async () => {
    const { packStagedDependencies, missingDependencies } = await load();
    const lines: string[] = [];
    const copied = await packStagedDependencies({
      stageDir: stage,
      appDir: app,
      target: WIN_X64,
      extraRequired: [KEYRING_X64],
      log: (line) => lines.push(line),
    });
    expect(copied).toEqual([KEYRING_X64, "playwright-core"]);
    expect(existsSync(join(app, "node_modules", "playwright-core", "package.json"))).toBe(true);
    expect(existsSync(join(app, "node_modules", ...KEYRING_X64.split("/")))).toBe(true);
    expect(existsSync(join(app, "node_modules", ...KEYRING_ARM64.split("/")))).toBe(false);
    expect(lines[0]).toContain("playwright-core");
    expect(missingDependencies(stage, app, WIN_X64, [KEYRING_X64])).toEqual([]);
  });

  it("fails the build when a dependency is not in the stage either", async () => {
    const { packStagedDependencies } = await load();
    rmSync(join(stage, "node_modules", "playwright-core"), { recursive: true });
    await expect(
      packStagedDependencies({
        stageDir: stage,
        appDir: app,
        target: WIN_X64,
        extraRequired: [KEYRING_X64],
        log: () => undefined,
      }),
    ).rejects.toThrow(/missing 1 runtime dependency.*playwright-core \(needed by the app\)/);
  });

  it("checks transitive dependencies, nested or hoisted", async () => {
    const { missingDependencies } = await load();
    writePackage(app, "playwright-core");
    writePackage(app, KEYRING_X64, { os: ["win32"], cpu: ["x64"] });
    expect(missingDependencies(stage, app, WIN_X64, [KEYRING_X64])).toEqual([]);

    rmSync(join(app, "node_modules", "node-addon-api"), { recursive: true });
    expect(missingDependencies(stage, app, WIN_X64)).toEqual([
      "node-addon-api (needed by node-pty)",
    ]);

    // Nested under its requirer resolves too.
    writePackage(join(app, "node_modules", "node-pty"), "node-addon-api");
    expect(missingDependencies(stage, app, WIN_X64)).toEqual([]);
  });
});
