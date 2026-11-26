/**
 * Agent Rishi desktop app, main process entry (§17).
 *
 *   Agent Rishi [--home <dir>] [--port <n>] [--hidden] [--fake] [agent-rishi://...]
 *
 * One instance per Agent Rishi home: a second launch focuses the first (and hands it a
 * `agent-rishi://` link). The Chromium profile lives in `<home>/desktop`, so an isolated
 * `--home` is a fully separate app (tests rely on this).
 */
import { resolve } from "node:path";
import { DEEP_LINK_SCHEME } from "@agent-rishi/contracts";
import { app } from "electron";
import { parseLaunchArgs } from "./args";
import { DesktopApp } from "./desktop-app";
import { redactToken } from "./security";
import { homeFiles } from "./server-plan";

const args = parseLaunchArgs(process.argv.slice(1));
app.setName("Agent Rishi");
app.setPath("userData", homeFiles(args.home).desktop);
if (process.platform === "win32") app.setAppUserModelId("dev.agent-rishi.app");

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  // Register `agent-rishi://` only for installed builds; a development run must not take it over.
  if (app.isPackaged) app.setAsDefaultProtocolClient(DEEP_LINK_SCHEME);
  else if (process.env.AGENT_RISHI_REGISTER_PROTOCOL === "1" && process.argv[1]) {
    app.setAsDefaultProtocolClient(DEEP_LINK_SCHEME, process.execPath, [resolve(process.argv[1])]);
  }

  const desktop = new DesktopApp(args);
  app.on("second-instance", (_event, argv) =>
    desktop.secondInstance(parseLaunchArgs(argv.slice(1))),
  );
  // macOS delivers links (also the one that launched the app) through `open-url`.
  app.on("open-url", (event, url) => {
    event.preventDefault();
    desktop.openLink(url);
  });
  app.on("activate", () => desktop.show());
  app.on("before-quit", (event) => desktop.beforeQuit(event));
  // Closing the last window keeps Agent Rishi in the tray; Quit is explicit.
  app.on("window-all-closed", () => {});
  app
    .whenReady()
    .then(() => desktop.start())
    .catch((error: unknown) => {
      console.error(redactToken(String(error)));
      // Quitting during startup (the server stops while the window loads) is not a crash:
      // the quit already under way finishes the job.
      if (!desktop.isQuitting) desktop.startupFailed();
    });
}
