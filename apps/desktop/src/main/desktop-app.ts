import { join } from "node:path";
import {
  type DesktopInfo,
  type DesktopUpdateCommand,
  deepLinkPath,
  parseDeepLink,
} from "@agent-rishi/contracts";
import { app, dialog, Menu, Notification, shell } from "electron";
import { CHANNELS } from "../shared/channels";
import { ActivityMonitor, type ServerStatus } from "./activity";
import type { LaunchArgs } from "./args";
import { AppBadge } from "./badge";
import { NativeBrowserFeature } from "./browser/feature";
import { type Connection, connect, launchUrl } from "./connection";
import { Diagnostics } from "./diagnostics";
import { exportDiagnostics } from "./diagnostics-menu";
import { armQuitWatchdog, forceExit } from "./exit";
import { registerBridge } from "./ipc";
import { appMenuTemplate } from "./menu";
import { loadAfterReady, waitForServer } from "./recovery";
import { homeFiles, mayReconnect, serverHealthy } from "./server-plan";
import {
  applyLaunchAtLogin,
  fileLogger,
  KeepAwake,
  launchAtLoginSupported,
  macSigned,
  openedAtLogin,
} from "./system";
import { AppTray } from "./tray";
import { trayView } from "./tray-view";
import { UpdateController } from "./updates/controller";
import { quitAction, standaloneAction, updateSupport } from "./updates/policy";
import { loadUpdater, waitForRunnerExit } from "./updates/updater";
import { MainWindow } from "./window";
import { windowShot } from "./window-shot";

const DOCS_URL = "https://github.com/sventkrtl/agent-rishi/blob/main/docs/desktop.md";
/** Longest a quit may take (browser hand-off 15 s + server stop up to 30 s) before it's forced. */
const QUIT_LIMIT_MS = 45_000;
/** How long "Quit and Stop Agents" gives the server to drain the runner (an update allows 90 s). */
const STOP_RUNNER_MS = 60_000;

type QuitInitiator =
  | "menu"
  | "tray"
  | "window"
  | "server-stop"
  | "server-crash"
  | "startup"
  | "system";

/**
 * The desktop app (§17): one window on the server's UI, a tray with live counts, the app
 * badge, keep-awake, native notifications and folder picking, `agent-rishi://` links and updates
 * from GitHub Releases. It starts the server (or attaches to a running one for the same home)
 * and leaves the runner running when it quits, as `agent-rishi` does.
 */
export class DesktopApp {
  private readonly log: (message: string) => void;
  private readonly dist = import.meta.dirname;
  private window!: MainWindow;
  private tray!: AppTray;
  private badge!: AppBadge;
  private readonly keepAwake = new KeepAwake();
  private updates!: UpdateController;
  private browser!: NativeBrowserFeature;
  private monitor: ActivityMonitor | undefined;
  private conn: Connection | undefined;
  private status: ServerStatus = { connected: false, activity: null, settings: null };
  private pendingPath: string | null = null;
  private loaded = false;
  private quitting = false;
  private quitInitiator: QuitInitiator = "system";
  /** Set by "Quit and Stop Agents": quitting stops the runner too. */
  private stopRunnerOnQuit = false;
  private readonly diagnostics: Diagnostics;
  private uiLoad: Connection | undefined;
  private connecting = false;
  private quitReady = false;
  private standaloneTimer: NodeJS.Timeout | undefined;

  /** True once a quit has started (startup errors after that are part of quitting). */
  get isQuitting(): boolean {
    return this.quitting;
  }
  private notifiedUpdate: string | null = null;

  constructor(private readonly args: LaunchArgs) {
    const { logs } = homeFiles(args.home);
    this.log = fileLogger(join(logs, "desktop.log"));
    this.diagnostics = new Diagnostics(join(logs, "desktop-diagnostics.json"));
    if (args.deepLink) this.pendingPath = this.pathFor(args.deepLink);
  }

  private asset(name: string): string {
    return join(this.dist, "assets", name);
  }

  async start(): Promise<void> {
    this.log(`app: Agent Rishi ${app.getVersion()} starting (home ${this.args.home})`);
    const unsupported = updateSupport({
      packaged: app.isPackaged,
      platform: process.platform,
      // `Agent Rishi.app/Contents/Resources/app` -> `Agent Rishi.app`.
      macSigned: await macSigned(join(app.getAppPath(), "..", "..", "..")),
    });
    this.updates = new UpdateController({
      current: app.getVersion(),
      unsupported,
      updater: () => loadUpdater(this.log),
      beforeInstall: () => this.prepareInstall(),
      log: this.log,
    });
    this.updates.onChange((state) => {
      this.conn?.server?.send({ type: "update.state", state });
      this.refresh();
      this.notifyUpdate();
    });

    app.on("child-process-gone", (_event, details) => {
      this.log(
        `app: ${details.type} child exited (code ${details.exitCode}, reason ${details.reason})`,
      );
      this.diagnostics.record({
        kind: "child-exit",
        reason: details.reason,
        code: details.exitCode,
      });
    });
    Menu.setApplicationMenu(Menu.buildFromTemplate(this.menu()));
    this.tray = new AppTray(
      this.asset(process.platform === "darwin" ? "trayTemplate.png" : "tray.png"),
      {
        open: () => this.show(),
        openInbox: () => this.navigate("/inbox"),
        update: (command) => void this.runUpdate(command),
        quit: () => this.quit("tray"),
        quitAndStopAgents: () => void this.quitAndStopAgents(),
      },
    );
    this.window = new MainWindow({
      preload: join(this.dist, "preload.cjs"),
      icon: this.asset("icon.png"),
      stateFile: join(homeFiles(this.args.home).desktop, "window-state.json"),
      show: !this.args.hidden && !openedAtLogin(),
      hideOnClose: () => this.status.settings?.desktop.closeToTray ?? true,
      quit: () => this.quit("window"),
      onRendererGone: (details, retry) => {
        this.diagnostics.record({
          kind: "renderer-exit",
          reason: details.reason,
          code: details.exitCode,
        });
        if (this.uiLoad === this.conn) return;
        this.loaded = false;
        if (retry) void this.loadUi();
        else void this.window.showRecovery();
      },
      log: this.log,
    });
    this.badge = new AppBadge(() => this.window.window, this.asset("badge.png"));
    this.browser = new NativeBrowserFeature({ window: () => this.window.window, log: this.log });
    registerBridge({
      info: () => this.info(),
      origin: () => this.window.serverOrigin,
      window: () => this.window.window,
      showWindow: () => this.show(),
      setBadge: (count) => this.badge.set(count),
      icon: this.asset("icon.png"),
      log: this.log,
      browser: this.browser.browsers,
    });
    this.exposeForTests();
    await this.open();
  }

  /** Connect to (or start) the server and load the UI. */
  private async open(): Promise<void> {
    if (this.conn || this.connecting || this.quitting) return;
    this.connecting = true;
    try {
      this.conn = await connect({
        args: this.args,
        serverEntry: join(this.dist, "server.js"),
        onUpdateCommand: (id, command) => void this.onServerCommand(id, command),
        onExit: (exit) => this.diagnostics.record({ kind: "server-exit", ...exit }),
        onUnexpectedExit: (code) => {
          void this.onServerExit(code).catch(() => {
            this.log("app: server restart failed");
            return this.window.showRecovery();
          });
        },
        log: this.log,
      });
    } catch (error) {
      this.log(`app: no server: ${String(error)}`);
      await dialog.showMessageBox({
        type: "error",
        title: "Agent Rishi could not start",
        message: "Agent Rishi could not start its server.",
        detail: `${error instanceof Error ? error.message : String(error)}\n\nSee ${homeFiles(this.args.home).logs}.`,
      });
      await this.window.showRecovery();
      return;
    } finally {
      this.connecting = false;
    }
    if (this.quitting) {
      await this.conn.server?.stop({ stopRunner: false });
      return;
    }
    this.conn.server?.send({ type: "update.state", state: this.updates.state });
    this.browser.connect(this.conn);

    this.monitor?.stop();
    this.monitor = new ActivityMonitor({
      baseUrl: this.conn.url,
      token: this.conn.token,
      onChange: (status) => this.onStatus(status),
    });
    this.monitor.start();
    if (!this.conn.server) this.startStandaloneUpdates();
    await this.loadUi();
  }

  private async loadUi(): Promise<void> {
    const conn = this.conn;
    if (!conn || this.quitting || this.uiLoad === conn) return;
    this.uiLoad = conn;
    const pendingPath = this.pendingPath;
    const load = async () => {
      if (this.quitting || this.conn !== conn) return;
      await this.window.load(launchUrl(conn, pendingPath ?? "/"));
    };
    try {
      await loadAfterReady(load, () =>
        waitForServer(conn.url, () => !this.quitting && this.conn === conn),
      );
      if (this.quitting || this.conn !== conn) return;
      this.loaded = true;
      const nextPath = this.pendingPath;
      this.pendingPath = null;
      if (nextPath && nextPath !== pendingPath) this.navigate(nextPath);
    } catch (error) {
      if (this.quitting || this.conn !== conn) return;
      this.log(`app: UI navigation failed: ${String(error)}`);
      this.loaded = false;
      await this.window.showRecovery();
    } finally {
      if (this.uiLoad === conn) this.uiLoad = undefined;
    }
  }

  private async retryLoading(): Promise<void> {
    if (this.quitting) return;
    const conn = this.conn;
    if (conn && !conn.server) {
      const reconnect = !(await serverHealthy(conn.url)) && (await mayReconnect(this.args.home));
      if (this.conn !== conn || this.quitting) return;
      if (reconnect) {
        this.conn = undefined;
        this.loaded = false;
        this.monitor?.stop();
        clearInterval(this.standaloneTimer);
      }
    }
    if (this.conn) await this.loadUi();
    else await this.open();
  }

  private quit(reason: QuitInitiator): void {
    if (this.quitting) return;
    this.quitInitiator = reason;
    app.quit();
  }

  /**
   * Quit and stop the runner too, after a confirmation: plain Quit leaves the runner (and its
   * agents) running, and until now only `agent-rishi stop` in a terminal stopped it. Only a server
   * this app started can be asked to stop the runner; one started elsewhere is left alone.
   */
  private async quitAndStopAgents(): Promise<void> {
    if (this.quitting) return;
    if (!this.conn?.server) {
      await dialog.showMessageBox({
        type: "info",
        title: "Agent Rishi",
        message: "The agents run in an Agent Rishi server this app didn't start.",
        detail: "Stop it with `agent-rishi stop` in a terminal.",
        buttons: ["OK"],
      });
      return;
    }
    const { response } = await dialog.showMessageBox({
      type: "warning",
      title: "Agent Rishi",
      message: "Stop the agents and quit?",
      detail:
        "Agent Rishi stops the runner gracefully, as `agent-rishi stop` does, so running agents and automations stop too. Sessions resume where they left off the next time you open Agent Rishi.",
      buttons: ["Stop Agents and Quit", "Cancel"],
      defaultId: 1,
      cancelId: 1,
    });
    if (response !== 0 || this.quitting) return;
    this.stopRunnerOnQuit = true;
    this.quit("tray");
  }

  startupFailed(): void {
    this.log("app: quit initiated by startup failure");
    this.diagnostics.record({ kind: "quit", reason: "startup" });
    forceExit(1);
  }

  show(): void {
    this.window?.show();
  }

  /** A second launch (or a `agent-rishi://` link on Windows and Linux) focuses this instance. */
  secondInstance(args: LaunchArgs): void {
    if (args.deepLink) this.openLink(args.deepLink);
    else if (!args.hidden) this.show();
  }

  openLink(url: string): void {
    const path = this.pathFor(url);
    if (!path) return;
    if (this.loaded) this.navigate(path);
    else this.pendingPath = path;
  }

  private pathFor(url: string): string | null {
    const target = parseDeepLink(url);
    if (!target) this.log(`app: ignored link ${url.slice(0, 200)}`);
    return target ? deepLinkPath(target) : null;
  }

  private navigate(path: string): void {
    this.show();
    if (this.loaded) this.window.window.webContents.send(CHANNELS.navigate, path);
    else this.pendingPath = path;
  }

  /** Quitting: install a downloaded update on the way out, else leave the runner running. */
  beforeQuit(event: Electron.Event): void {
    if (this.quitReady) return;
    event.preventDefault();
    if (this.quitting) return;
    this.quitting = true;
    this.log(
      `app: quit initiated by ${this.quitInitiator}${this.stopRunnerOnQuit ? " (stopping the agents too)" : ""}`,
    );
    this.diagnostics.record({ kind: "quit", reason: this.quitInitiator });
    // Every step below is bounded, but quitting must finish even if one isn't: a timer here,
    // and a separate process for when the main thread itself is stuck in native shutdown.
    // Stopping the runner may take its full drain time on top.
    const limit = QUIT_LIMIT_MS + (this.stopRunnerOnQuit ? STOP_RUNNER_MS + 15_000 : 0);
    const watchdog = setTimeout(() => {
      this.log(`app: still quitting after ${limit / 1000} s; exiting now`);
      forceExit(0);
    }, limit);
    const hardStop = armQuitWatchdog(limit + 5_000, this.log);
    void (async () => {
      try {
        this.window?.allowClose();
        clearInterval(this.standaloneTimer);
        this.monitor?.stop();
        this.keepAwake.set(false);
        // Open session browsers move to the runner's Chromium before the views go.
        await this.browser?.quit();
        if (this.updates && quitAction(this.updates.state.phase) === "install") {
          // Installing drains the runner first (up to 90 s); the installer ends the app.
          clearTimeout(watchdog);
          hardStop.cancel();
          await this.updates.installOnQuit();
          return;
        }
        if (this.stopRunnerOnQuit && this.conn?.server) {
          // As `agent-rishi stop`: the runner drains and exits, within the raised limit below.
          await this.conn.server.stop({ stopRunner: true, timeoutMs: STOP_RUNNER_MS });
          await waitForRunnerExit(homeFiles(this.args.home).runnerLock, 15_000, this.log);
        } else {
          await this.conn?.server?.stop({ stopRunner: false });
        }
        this.tray?.destroy();
      } catch (error) {
        // A failed step must not leave the app unable to quit.
        this.log(`app: while quitting: ${String(error)}`);
      }
      this.quitReady = true;
      app.quit();
    })();
  }

  /** Before the installer runs: stop the server and drain the runner (as `agent-rishi stop`). */
  private async prepareInstall(): Promise<void> {
    this.log("app: preparing to quit for an update");
    this.diagnostics.record({ kind: "quit", reason: "update" });
    this.window.allowClose();
    this.monitor?.stop();
    const server = this.conn?.server;
    if (server) {
      await server.stop({ stopRunner: true, timeoutMs: 90_000 });
      await waitForRunnerExit(homeFiles(this.args.home).runnerLock, 15_000, this.log);
    }
    this.quitReady = true;
  }

  private async onServerCommand(id: string, command: DesktopUpdateCommand): Promise<void> {
    let error: string | null = null;
    try {
      await this.updates.run(command);
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    }
    this.conn?.server?.send({ type: "update.done", id, error });
  }

  private async runUpdate(command: DesktopUpdateCommand): Promise<void> {
    await this.updates.run(command).catch((e: unknown) => this.log(`updates: ${String(e)}`));
  }

  private async onServerExit(code: number | null): Promise<void> {
    if (this.quitting) return;
    this.loaded = false;
    this.conn = undefined;
    this.monitor?.stop();
    if (code === 0) {
      // Stopped on purpose (`agent-rishi stop` from a terminal): quit with it.
      this.log("app: the server was stopped; quitting");
      this.quit("server-stop");
      return;
    }
    const { response } = await dialog.showMessageBox({
      type: "error",
      title: "Agent Rishi",
      message: "The Agent Rishi server stopped unexpectedly.",
      detail: `Agents keep running in the runner. See ${homeFiles(this.args.home).logs}.`,
      buttons: ["Restart", "Quit"],
      defaultId: 0,
    });
    if (this.quitting) return;
    if (response === 0) await this.open();
    else this.quit("server-crash");
  }

  private onStatus(status: ServerStatus): void {
    this.status = status;
    const desktop = status.settings?.desktop;
    if (desktop) applyLaunchAtLogin(desktop.launchAtLogin);
    const running = status.activity?.running ?? 0;
    this.keepAwake.set(Boolean(desktop?.keepAwake ?? true) && running > 0);
    this.refresh();
  }

  private refresh(): void {
    if (!this.tray || !this.updates) return;
    const view = trayView({
      activity: this.status.activity,
      connected: this.status.connected,
      update: this.updates.state,
      autoUpdate: this.status.settings?.updates.mode === "auto",
    });
    this.tray.update(view);
    if (this.status.connected) this.badge?.set(view.badge);
  }

  /** Attached to a server started by `agent-rishi`: follow the update mode here (§17). */
  private startStandaloneUpdates(): void {
    const conn = this.conn;
    const tick = () => {
      if (this.conn !== conn) return;
      const settings = this.status.settings;
      if (!settings) return;
      const state = this.updates.state;
      const action = standaloneAction({
        mode: settings.updates.mode,
        phase: state.phase,
        unsupported: state.unsupported,
        checkedAt: state.checkedAt ? Date.parse(state.checkedAt) : null,
        now: Date.now(),
      });
      if (action) void this.runUpdate(action);
    };
    this.standaloneTimer = setInterval(tick, 60_000);
    setTimeout(tick, 5_000).unref();
  }

  /** Without our own server there is no update banner: say it with a notification. */
  private notifyUpdate(): void {
    const state = this.updates.state;
    if (this.conn?.server !== null || !Notification.isSupported() || !state.latest) return;
    if (state.phase !== "available" && state.phase !== "downloaded") return;
    const key = `${state.phase}:${state.latest}`;
    if (this.notifiedUpdate === key) return;
    this.notifiedUpdate = key;
    new Notification({
      title: `Agent Rishi ${state.latest} is ${state.phase === "downloaded" ? "ready" : "available"}`,
      body:
        state.phase === "downloaded"
          ? "It installs when you quit Agent Rishi, or choose Restart to update in the tray menu."
          : "Download it from the tray menu.",
    }).show();
  }

  private info(): DesktopInfo {
    return {
      version: app.getVersion(),
      platform: process.platform as DesktopInfo["platform"],
      packaged: app.isPackaged,
      ownsServer: Boolean(this.conn?.server),
      launchAtLoginSupported,
      nativeBrowser: true,
    };
  }

  private menu() {
    return appMenuTemplate(process.platform, {
      openSettings: () => this.navigate("/settings/general"),
      openInbox: () => this.navigate("/inbox"),
      checkForUpdates: () => {
        this.navigate("/settings/about");
        void this.runUpdate("check");
      },
      openDocs: () => void shell.openExternal(DOCS_URL),
      openLogs: () => void shell.openPath(homeFiles(this.args.home).logs),
      exportDiagnostics: () => void exportDiagnostics(this.diagnostics),
      retryLoading: () => {
        void this.retryLoading().catch(() => this.log("app: could not retry loading the UI"));
      },
      quit: () => this.quit("menu"),
      quitAndStopAgents: () => void this.quitAndStopAgents(),
      zoom: (command) => {
        this.window?.zoom(command);
        this.browser?.browsers.layout();
      },
    });
  }

  /** Read-only hooks for the desktop smoke test (`AGENT_RISHI_DESKTOP_TEST=1`). */
  private exposeForTests(): void {
    if (process.env.AGENT_RISHI_DESKTOP_TEST !== "1") return;
    (globalThis as Record<string, unknown>).__agentRishiDesktopTest = {
      trayLabels: () => this.tray.menuLabels(),
      status: () => this.status,
      ownsServer: () => Boolean(this.conn?.server),
      serverPid: () => this.conn?.server?.pid ?? null,
      keepAwake: () => this.keepAwake.active,
      updateState: () => this.updates.state,
      zoomFactor: () => this.window.zoomFactor,
      nativeViews: () => this.browser.browsers.views(),
      windowShot: () => windowShot(this.window.window),
    };
  }
}
