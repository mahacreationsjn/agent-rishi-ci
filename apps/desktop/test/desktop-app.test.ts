import { DATABASE_DAMAGED } from "@agent-rishi/contracts";
import { dialog } from "electron";
import { afterEach, describe, expect, it, vi } from "vitest";
import { type Connection, connect } from "../src/main/connection";
import { DesktopApp } from "../src/main/desktop-app";
import { mayReconnect, serverHealthy } from "../src/main/server-plan";
import { ServerStartError } from "../src/main/server-process";

vi.mock("electron", () => ({ dialog: { showMessageBox: vi.fn() } }));
vi.mock("../src/main/connection", () => ({ connect: vi.fn() }));
vi.mock("../src/main/server-plan", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/main/server-plan")>()),
  serverHealthy: vi.fn(),
  mayReconnect: vi.fn(),
}));
vi.mock("../src/main/system", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/main/system")>()),
  fileLogger: () => vi.fn(),
}));

afterEach(() => vi.resetAllMocks());

function desktop() {
  return new DesktopApp({ home: "/unused", port: null, hidden: true, fake: true, deepLink: null });
}

const attached: Connection = {
  url: "http://127.0.0.1:4317",
  token: "test",
  version: "test",
  server: null,
};

it("keeps the server started by Retry while the crash dialog is open", async () => {
  const instance = desktop();
  const answer = Promise.withResolvers<{ response: number; checkboxChecked: boolean }>();
  vi.mocked(dialog.showMessageBox).mockReturnValueOnce(answer.promise);
  vi.mocked(dialog.showMessageBox).mockResolvedValue({ response: 0, checkboxChecked: false });
  const exited = instance["onServerExit"](1);
  const replacement = { ...attached, server: {} as NonNullable<Connection["server"]> };
  instance["conn"] = replacement;
  instance["window"] = { showRecovery: vi.fn() } as unknown as (typeof instance)["window"];
  vi.mocked(connect).mockRejectedValue(new Error("unexpected reconnect"));

  answer.resolve({ response: 0, checkboxChecked: false });
  await exited;

  expect(connect).not.toHaveBeenCalled();
  expect(instance["conn"]).toBe(replacement);
});

describe("a server that refuses a damaged database", () => {
  const damaged = () =>
    new ServerStartError(
      "The database (…) looks damaged after Agent Rishi last stopped",
      DATABASE_DAMAGED,
    );

  function opening() {
    const instance = desktop();
    const showRecovery = vi.fn();
    instance["window"] = { showRecovery } as unknown as (typeof instance)["window"];
    const open = (instance as unknown as { open(): Promise<void> }).open.bind(instance);
    return { open, showRecovery };
  }

  it("offers to restore the newest backup, and starts the server again with it", async () => {
    const { open, showRecovery } = opening();
    vi.mocked(connect)
      .mockRejectedValueOnce(damaged())
      .mockRejectedValueOnce(new Error("still failing"));
    vi.mocked(dialog.showMessageBox).mockResolvedValue({ response: 0, checkboxChecked: false });

    await open();

    const offer = vi.mocked(dialog.showMessageBox).mock.calls[0]?.[0];
    expect(offer?.message).toBe("Agent Rishi's database looks damaged.");
    expect(offer?.buttons).toEqual(["Restore Newest Backup", "Not Now"]);
    expect(vi.mocked(connect).mock.calls.map(([o]) => o.restoreNewestBackup)).toEqual([
      undefined,
      true,
    ]);
    // The second failure is shown as it is, never offered again (no loop).
    expect(vi.mocked(dialog.showMessageBox).mock.calls[1]?.[0].message).toBe(
      "Agent Rishi could not start its server.",
    );
    expect(showRecovery).toHaveBeenCalledTimes(1);
  });

  it("leaves everything as it is on Not Now", async () => {
    const { open, showRecovery } = opening();
    vi.mocked(connect).mockRejectedValueOnce(damaged());
    vi.mocked(dialog.showMessageBox).mockResolvedValue({ response: 1, checkboxChecked: false });

    await open();

    expect(connect).toHaveBeenCalledTimes(1);
    expect(showRecovery).toHaveBeenCalledTimes(1);
  });
});

// An attached server that doesn't answer is only left when it is gone (or the home's server
// answers elsewhere): one that still runs is kept, so Retry never starts a second server.
it.each([
  { healthy: true, gone: true, reconnects: false },
  { healthy: false, gone: true, reconnects: true },
  { healthy: false, gone: false, reconnects: false },
])(
  "retries an attached server (healthy $healthy, gone $gone)",
  async ({ healthy, gone, reconnects }) => {
    const instance = desktop();
    instance["conn"] = attached;
    vi.mocked(serverHealthy).mockResolvedValue(healthy);
    vi.mocked(mayReconnect).mockResolvedValue(gone);
    const methods = instance as unknown as { open(): Promise<void>; loadUi(): Promise<void> };
    const open = vi.spyOn(methods, "open").mockResolvedValue();
    const load = vi.spyOn(methods, "loadUi").mockResolvedValue();

    const help = instance["menu"]().find((item) => item.role === "help")?.submenu;
    const retry = Array.isArray(help)
      ? help.find((item) => item.label === "Retry Loading Agent Rishi")
      : undefined;
    if (!retry?.click) throw new Error("Retry menu item missing");
    Reflect.apply(retry.click, undefined, []);
    await vi.waitFor(() => expect(open.mock.calls.length + load.mock.calls.length).toBe(1));

    expect(serverHealthy).toHaveBeenCalledWith(attached.url);
    expect(instance["conn"]).toBe(reconnects ? undefined : attached);
    expect(open).toHaveBeenCalledTimes(reconnects ? 1 : 0);
    expect(load).toHaveBeenCalledTimes(reconnects ? 0 : 1);
  },
);
