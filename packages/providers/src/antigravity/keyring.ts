import path from "node:path";
import { runCommand } from "../util/exec";

/** Check the keyring's metadata for an OAuth entry. Neither command retrieves its password. */
export async function hasAgyKeyringEntry(platform: NodeJS.Platform): Promise<boolean> {
  const options = { timeoutMs: 2_000 };
  if (platform === "win32") {
    const cmdkey = path.win32.join(
      process.env.SystemRoot ?? "C:\\Windows",
      "System32",
      "cmdkey.exe",
    );
    const result = await runCommand(
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
    const result = await runCommand(
      { kind: "native", path: "/usr/bin/security" },
      ["find-generic-password", "-s", "gemini", "-a", "antigravity"],
      options,
    );
    return result.code === 0;
  }
  // The Secret Service lookup attributes are unverified on Linux.
  return false;
}
