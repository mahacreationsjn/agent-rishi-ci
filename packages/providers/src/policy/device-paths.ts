/**
 * Windows device paths (§11.2): `\\?\C:\x`, `\\.\C:\x`, `//?/C:/x` and the NT form `\??\C:\x` open
 * the file `C:\x`, and `\\?\UNC\server\share\x` the share `\\server\share\x`. Read as written, they
 * look like a UNC path on a server named `?` or `.`, so Agent Rishi's home and the worktree would not be
 * recognised in them. Other device paths (`\\?\Volume{…}\x`, `\\.\pipe\x`) stay as they are.
 */
const DEVICE = /^(?:[\\/]{2}[?.]|\\\?\?)[\\/](?:([a-z]:(?:[\\/]|$))|unc[\\/])/i;

/** `value` (a Windows path) with a device prefix before a drive or `UNC` taken off. */
export function fromDevicePath(value: string): string {
  const match = DEVICE.exec(value);
  if (!match) return value;
  const rest = value.slice(match[0].length);
  return match[1] ? match[1] + rest : `\\\\${rest}`;
}
