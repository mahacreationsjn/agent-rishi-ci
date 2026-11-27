import { closeSync, fsyncSync, mkdirSync, openSync, renameSync, rmSync, writeSync } from "node:fs";
import { dirname } from "node:path";

/** Options for `writeFileDurably`. */
export interface DurableWriteOptions {
  /** File mode for a new file, e.g. `0o600` for one holding a secret. */
  mode?: number;
}

/**
 * Replace `file` with `content` so that a crash or a power cut leaves either the old file or the
 * new one, never an empty or zero-filled one. A temporary file next to it is written and flushed
 * to disk before it is renamed over `file`, and on POSIX the folder is flushed too, so the
 * rename itself survives. Without the flush, a system that loses power can keep the rename but
 * not the data behind it. Creates missing parent folders. Throws on failure, leaving `file`
 * untouched and no temporary file behind.
 */
export function writeFileDurably(
  file: string,
  content: string | Uint8Array,
  opts: DurableWriteOptions = {},
): void {
  const dir = dirname(file);
  mkdirSync(dir, { recursive: true });
  const tmp = `${file}.agent-rishi-${process.pid}.tmp`;
  const data = typeof content === "string" ? Buffer.from(content, "utf8") : content;
  try {
    const fd = openSync(tmp, "w", opts.mode ?? 0o666);
    try {
      let written = 0;
      while (written < data.length) {
        written += writeSync(fd, data, written, data.length - written);
      }
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    renameSync(tmp, file);
  } catch (error) {
    rmSync(tmp, { force: true });
    throw error;
  }
  syncFolder(dir);
}

/**
 * Flush a folder's entries (the rename) to disk. POSIX only: Windows can't open a folder for
 * flushing from Node, and NTFS journals the rename itself. Best effort: a file system that
 * refuses it keeps the already-flushed data.
 */
function syncFolder(dir: string): void {
  if (process.platform === "win32") return;
  let fd: number | undefined;
  try {
    fd = openSync(dir, "r");
    fsyncSync(fd);
  } catch {
    // Some file systems don't support flushing a folder; the data is already on disk.
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}
