import path from "node:path";
import { type ResolvedCommand, runCommand } from "../util/exec";

/** Runs a command and returns its exit code and output (injectable for tests). */
export type KeyringRun = (
  command: ResolvedCommand,
  args: string[],
  opts: { timeoutMs: number },
) => Promise<{ code: number | null; stdout: string }>;

/** Antigravity CLI's keyring entry: service `gemini`, account `antigravity`. */
const SERVICE = "gemini";
const ACCOUNT = "antigravity";

/**
 * The attribute that names the account in a Secret Service item differs between keyring
 * libraries (`username` or `account`); both are searched, always with the service.
 */
const LINUX_ACCOUNT_ATTRIBUTES = ["username", "account"] as const;

/**
 * Check the keyring's metadata for Antigravity CLI's OAuth entry. No command here retrieves a
 * password: Windows lists credential targets, macOS asks whether the item exists, and Linux
 * asks the Secret Service which item paths match (`SearchItems`), never for a secret.
 */
export async function hasAgyKeyringEntry(
  platform: NodeJS.Platform,
  run: KeyringRun = runCommand,
): Promise<boolean> {
  const options = { timeoutMs: 2_000 };
  if (platform === "win32") {
    const cmdkey = path.win32.join(
      process.env.SystemRoot ?? "C:\\Windows",
      "System32",
      "cmdkey.exe",
    );
    const result = await run(
      { kind: "native", path: cmdkey },
      ["/list:gemini:antigravity"],
      options,
    );
    // cmdkey can exit successfully with no match. Match the target, independent of localized labels.
    return (
      result.code === 0 &&
      /^[^:\r\n]+:[ \t]+(?:LegacyGeneric:target=)?gemini:antigravity[ \t]*\r?$/im.test(
        result.stdout,
      )
    );
  }
  if (platform === "darwin") {
    const result = await run(
      { kind: "native", path: "/usr/bin/security" },
      ["find-generic-password", "-s", SERVICE, "-a", ACCOUNT],
      options,
    );
    return result.code === 0;
  }
  if (platform === "linux") return hasSecretServiceItem(run, options);
  return false;
}

/**
 * Ask the Secret Service (GNOME Keyring, KWallet's bridge, ...) over the session bus for items
 * with the entry's attributes: `gdbus` (GLib), else `busctl` (systemd). Locked items count:
 * the login is there, the keyring unlocks when the CLI needs it. No bus, no service or neither
 * tool: false, which detection reports as an unknown login.
 */
async function hasSecretServiceItem(
  run: KeyringRun,
  options: { timeoutMs: number },
): Promise<boolean> {
  for (const attribute of LINUX_ACCOUNT_ATTRIBUTES) {
    const gdbus = await run(
      { kind: "native", path: "gdbus" },
      [
        "call",
        "--session",
        "--dest",
        "org.freedesktop.secrets",
        "--object-path",
        "/org/freedesktop/secrets",
        "--method",
        "org.freedesktop.Secret.Service.SearchItems",
        `{'service': '${SERVICE}', '${attribute}': '${ACCOUNT}'}`,
      ],
      options,
    );
    if (gdbus.code === 0) {
      if (secretServiceFound(gdbus.stdout)) return true;
      continue;
    }
    const busctl = await run(
      { kind: "native", path: "busctl" },
      [
        "--user",
        "call",
        "org.freedesktop.secrets",
        "/org/freedesktop/secrets",
        "org.freedesktop.Secret.Service",
        "SearchItems",
        "a{ss}",
        "2",
        "service",
        SERVICE,
        attribute,
        ACCOUNT,
      ],
      options,
    );
    if (busctl.code === 0 && secretServiceFound(busctl.stdout)) return true;
  }
  return false;
}

/**
 * Whether a `SearchItems` answer lists an item, unlocked or locked. `gdbus` prints
 * `([objectpath '/org/freedesktop/secrets/collection/login/3'], @ao [])`, `busctl` prints
 * `ao 1 "/org/freedesktop/secrets/collection/login/3" ao 0`; with no match, neither names a path.
 */
export function secretServiceFound(stdout: string): boolean {
  return /['"]\/org\/freedesktop\/secrets\/[^'"\s]+['"]/.test(stdout);
}
