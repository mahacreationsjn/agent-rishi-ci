import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { _electron, type ElectronApplication, expect, test } from "@playwright/test";
import { processesMentioning, sweepProcesses } from "../../web/e2e/support/process-sweep";
import { unpackedApp } from "./support";

/**
 * "Quit and Stop Agents" (File menu and tray): after the user confirms, the app quits and the
 * runner stops too, as `agent-rishi stop` does; plain Quit (the smoke test) leaves it running.
 */
let base: string;
let home: string;
let app: ElectronApplication | undefined;

test.beforeAll(() => {
  base = realpathSync.native(mkdtempSync(join(tmpdir(), "agent-rishi-e2e-quit-stop-")));
  home = join(base, "home");
});

test.afterAll(async () => {
  if (app) {
    const proc = app.process();
    if (proc.pid && proc.exitCode === null) proc.kill();
  }
  const left = await sweepProcesses(home, 15_000);
  if (left.length) console.warn(`quit-and-stop e2e: stopped ${left.length} leftover process(es)`);
  rmSync(base, { recursive: true, force: true, maxRetries: 5, retryDelay: 500 });
});

/** Click a File (or macOS app) menu item by label, the way the menu would. */
const clickMenuItem = (electronApp: ElectronApplication, label: string) =>
  electronApp.evaluate(({ Menu }, wanted) => {
    for (const top of Menu.getApplicationMenu()?.items ?? []) {
      const item = top.submenu?.items.find((i) => i.label === wanted);
      if (item) {
        item.click();
        return;
      }
    }
    throw new Error(`no menu item "${wanted}"`);
  }, label);

/** Answer the next confirmation dialog with button `response`. */
const answerDialog = (electronApp: ElectronApplication, response: number) =>
  electronApp.evaluate(({ dialog }, r) => {
    dialog.showMessageBox = (async () => ({ response: r, checkboxChecked: false })) as never;
  }, response);

test("Quit and Stop Agents asks first, then stops the runner with the app", async () => {
  const env = {
    ...process.env,
    AGENT_RISHI_HOME: "",
    AGENT_RISHI_DESKTOP_TEST: "1",
    AGENT_RISHI_UPDATE_CHECK: "0",
    AGENT_RISHI_GITHUB_SYNC: "0",
    AGENT_RISHI_BUILTIN_PROVIDERS: "0",
  };
  const launchArgs = ["--home", home, "--port", "0", "--fake"];
  if (process.platform === "linux") launchArgs.push("--no-sandbox");
  app = await _electron.launch({ executablePath: unpackedApp(), args: launchArgs, env });
  await app.firstWindow();
  const runnerFile = join(home, "runner", "runner.json");
  await expect.poll(() => existsSync(runnerFile), { timeout: 60_000 }).toBe(true);
  const runnerPid = JSON.parse(readFileSync(runnerFile, "utf8")).pid as number;
  const runnerAlive = () => processesMentioning(home).some((p) => p.pid === runnerPid);
  expect(runnerAlive()).toBe(true);

  await test.step("Cancel keeps everything running", async () => {
    await answerDialog(app as ElectronApplication, 1);
    await clickMenuItem(app as ElectronApplication, "Quit and Stop Agents...");
    await new Promise((r) => setTimeout(r, 1_000));
    expect((app as ElectronApplication).process().exitCode).toBeNull();
    expect(runnerAlive()).toBe(true);
  });

  await test.step("confirming quits the app and stops the runner", async () => {
    const exited = new Promise((done) => (app as ElectronApplication).process().once("exit", done));
    await answerDialog(app as ElectronApplication, 0);
    await clickMenuItem(app as ElectronApplication, "Quit and Stop Agents...");
    await exited;
    app = undefined;
    await expect.poll(runnerAlive, { timeout: 60_000 }).toBe(false);
    // Nothing of this home outlives the app: no server, no runner, no agents.
    await expect.poll(() => processesMentioning(home).length, { timeout: 30_000 }).toBe(0);
  });
});
