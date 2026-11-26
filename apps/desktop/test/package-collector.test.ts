import { afterEach, expect, it, vi } from "vitest";

const { build, spawnSync } = vi.hoisted(() => ({
  build: vi.fn(async () => []),
  spawnSync: vi.fn(() => ({ status: 0 })),
}));

vi.mock("electron-builder", () => {
  const platform = { createTarget: () => new Map() };
  return {
    build,
    Arch: { [process.arch]: 0 },
    Platform: { WINDOWS: platform, MAC: platform, LINUX: platform },
  };
});
vi.mock("node:child_process", () => ({ spawnSync }));
vi.mock("node:fs", () => ({
  cpSync: vi.fn(),
  existsSync: () => true,
  mkdirSync: vi.fn(),
  readFileSync: () => JSON.stringify({ version: "1.0.0" }),
  rmSync: vi.fn(),
  writeFileSync: vi.fn(),
}));
vi.mock("node:module", () => ({
  createRequire: () => Object.assign(() => undefined, { resolve: () => "electron/package.json" }),
}));
vi.mock("node:util", () => ({ parseArgs: () => ({ values: { dir: true, publish: "never" } }) }));

afterEach(() => vi.unstubAllEnvs());

it("selects the npm collector for an npm stage when launched by pnpm", async () => {
  const pnpmAgent = "pnpm/10.12.1 npm/? node/v24.0.0";
  vi.stubEnv("npm_config_user_agent", pnpmAgent);
  vi.stubEnv("npm_execpath", "/tools/pnpm.cjs");
  spawnSync.mockImplementation(() => {
    expect(process.env.npm_config_user_agent).toBe(pnpmAgent);
    return { status: 0 };
  });
  build.mockImplementation(async () => {
    expect(process.env.npm_config_user_agent).toBe("npm");
    return [];
  });

  const script = "../scripts/package.mjs";
  await import(/* @vite-ignore */ script);

  expect(spawnSync).toHaveBeenCalledOnce();
  expect(build).toHaveBeenCalledOnce();
});
