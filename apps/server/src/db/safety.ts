import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
} from "node:fs";
import { join } from "node:path";
import { backup, DatabaseSync } from "node:sqlite";

/**
 * Keeping the database safe (F1 of `docs/foundation.md`): verified backups in
 * `<home>/backups/db`, an integrity check after an unclean shutdown, and restore.
 *
 * A backup is a full, consistent copy made with SQLite's online backup, so it can be taken
 * while the server runs. It is checked (`PRAGMA quick_check`) before it is kept, and only the
 * newest `DB_BACKUPS_KEPT` are kept.
 */

/** How many verified backups are kept; older ones are deleted after each new one. */
export const DB_BACKUPS_KEPT = 7;

/** A backup older than this is replaced by a new one while the server runs. */
export const DB_BACKUP_EVERY_MS = 24 * 60 * 60 * 1000;

/** How often the running server looks whether a backup is due. */
export const DB_BACKUP_CHECK_MS = 60 * 60 * 1000;

/** One backup file. */
export interface DbBackup {
  /** File name, e.g. `agent-rishi-20261127T120000Z-v0.8.0.db`: what `restore` takes. */
  name: string;
  file: string;
  takenAt: Date;
  /** The Agent Rishi version that took it (the schema it holds). */
  version: string;
  bytes: number;
}

const BACKUP_NAME = /^agent-rishi-(\d{8}T\d{6}Z)-v([0-9A-Za-z.+-]+)\.db$/;

/** `<home>/backups/db`. */
export function dbBackupDir(home: string): string {
  return join(home, "backups", "db");
}

/** `20261127T120000Z` for a date. */
function stamp(at: Date): string {
  return at
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/\.\d+Z$/, "Z");
}

function parseStamp(s: string): Date {
  const iso = `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}T${s.slice(9, 11)}:${s.slice(11, 13)}:${s.slice(13, 15)}Z`;
  return new Date(iso);
}

/** The backups in `dir`, newest first. Files that aren't backups are ignored. */
export function listDbBackups(dir: string): DbBackup[] {
  if (!existsSync(dir)) return [];
  const found: DbBackup[] = [];
  for (const name of readdirSync(dir)) {
    const m = BACKUP_NAME.exec(name);
    if (!m?.[1] || !m[2]) continue;
    const file = join(dir, name);
    found.push({
      name,
      file,
      takenAt: parseStamp(m[1]),
      version: m[2],
      bytes: statSync(file).size,
    });
  }
  return found.sort((a, b) => b.takenAt.getTime() - a.takenAt.getTime());
}

/**
 * Problems SQLite finds in the database file (`PRAGMA quick_check`); empty when it is sound.
 * A file SQLite can't open at all reports that as its problem. Opens the file normally, so a
 * write-ahead log left by a crash is applied first, as the server would.
 */
export function checkDatabaseFile(file: string): string[] {
  let db: DatabaseSync | undefined;
  try {
    db = new DatabaseSync(file);
    const rows = db.prepare("PRAGMA quick_check").all() as Array<Record<string, unknown>>;
    const messages = rows.map((r) => String(Object.values(r)[0] ?? ""));
    return messages.length === 1 && messages[0] === "ok" ? [] : messages;
  } catch (error) {
    return [error instanceof Error ? error.message : String(error)];
  } finally {
    if (db?.isOpen) db.close();
  }
}

/**
 * Copy the database (an open connection or a file) into a new verified backup in `dir`, then
 * keep only the newest `keep`. Throws, leaving no partial file, when the copy fails or doesn't
 * pass the check.
 */
export async function backupDatabase(
  source: DatabaseSync | string,
  dir: string,
  version: string,
  opts: { now?: Date; keep?: number } = {},
): Promise<DbBackup> {
  mkdirSync(dir, { recursive: true });
  const now = opts.now ?? new Date();
  const name = `agent-rishi-${stamp(now)}-v${version}.db`;
  const file = join(dir, name);
  const partial = `${file}.partial`;
  const db = typeof source === "string" ? new DatabaseSync(source) : source;
  try {
    rmSync(partial, { force: true });
    await backup(db, partial);
    const problems = checkDatabaseFile(partial);
    if (problems.length) throw new Error(`the backup failed its check: ${problems[0]}`);
    renameSync(partial, file);
  } catch (error) {
    rmSync(partial, { force: true });
    throw error;
  } finally {
    if (typeof source === "string" && db.isOpen) db.close();
  }
  pruneDbBackups(dir, opts.keep ?? DB_BACKUPS_KEPT);
  return { name, file, takenAt: now, version, bytes: statSync(file).size };
}

/** Delete all but the newest `keep` backups in `dir`. */
export function pruneDbBackups(dir: string, keep: number): void {
  for (const old of listDbBackups(dir).slice(keep)) rmSync(old.file, { force: true });
}

/** The database looks damaged; the server does not start on it. */
export class DatabaseDamagedError extends Error {
  constructor(
    readonly file: string,
    readonly problems: string[],
    readonly newestBackup: DbBackup | undefined,
  ) {
    const fix = newestBackup
      ? `Restore the newest backup (${newestBackup.takenAt.toISOString()}) with: agent-rishi restore ${newestBackup.name}`
      : "There is no backup to restore. Move the file aside to start with an empty database.";
    super(
      `The database (${file}) looks damaged after Agent Rishi last stopped unexpectedly: ${problems[0]}. Nothing was changed. ${fix}`,
    );
    this.name = "DatabaseDamagedError";
  }
}

export interface PrepareDatabaseOptions {
  /** The database file (`<home>/agent-rishi.db`). */
  file: string;
  /** Where backups go (`dbBackupDir(home)`). */
  backupDir: string;
  /** This Agent Rishi's version. */
  version: string;
  /** The server didn't stop cleanly last time (its lock file was left behind). */
  uncleanShutdown: boolean;
  log?: (message: string) => void;
}

/**
 * Before the server opens the database and migrates it: after an unclean shutdown, check it and
 * refuse to start on a damaged one (`DatabaseDamagedError`); then, when no backup was taken by
 * this version yet (a first start, or an upgrade whose migrations are about to run), take one.
 * Does nothing for a database that doesn't exist yet.
 */
export async function prepareDatabase(opts: PrepareDatabaseOptions): Promise<DbBackup | undefined> {
  if (!existsSync(opts.file)) return undefined;
  const backups = listDbBackups(opts.backupDir);
  if (opts.uncleanShutdown) {
    const problems = checkDatabaseFile(opts.file);
    if (problems.length) throw new DatabaseDamagedError(opts.file, problems, backups[0]);
    opts.log?.("database: checked after an unclean shutdown, it is sound");
  }
  if (backups.some((b) => b.version === opts.version)) return undefined;
  const taken = await backupDatabase(opts.file, opts.backupDir, opts.version);
  opts.log?.(`database: backed up before starting ${opts.version} (${taken.name})`);
  return taken;
}

/** What `restoreDatabase` did. */
export interface RestoreResult {
  restored: DbBackup;
  /** Where the database it replaced was moved (with its `-wal` and `-shm`), if there was one. */
  setAside: string | undefined;
}

/**
 * Put the backup named `name` (from `backupDir`) in place of the database `file`. The server must
 * not be running. The backup is checked first; the current database and its `-wal` and `-shm`
 * files are moved aside as `<file>.before-restore-<stamp>`, never deleted. Throws when the
 * backup doesn't exist or fails its check, changing nothing.
 */
export function restoreDatabase(
  file: string,
  backupDir: string,
  name: string,
  now = new Date(),
): RestoreResult {
  const restored = listDbBackups(backupDir).find((b) => b.name === name);
  if (!restored) throw new Error(`No backup named ${name} in ${backupDir}`);
  const problems = checkDatabaseFile(restored.file);
  if (problems.length) throw new Error(`The backup ${name} failed its check: ${problems[0]}`);
  let setAside: string | undefined;
  if (existsSync(file)) {
    setAside = `${file}.before-restore-${stamp(now)}`;
    renameSync(file, setAside);
  }
  for (const suffix of ["-wal", "-shm"]) {
    if (existsSync(`${file}${suffix}`)) {
      renameSync(
        `${file}${suffix}`,
        `${setAside ?? `${file}.before-restore-${stamp(now)}`}${suffix}`,
      );
    }
  }
  copyFileSync(restored.file, file);
  return { restored, setAside };
}

/** True when the newest backup is older than `everyMs` (or there is none). */
export function dbBackupDue(dir: string, now = new Date(), everyMs = DB_BACKUP_EVERY_MS): boolean {
  const newest = listDbBackups(dir)[0];
  return !newest || now.getTime() - newest.takenAt.getTime() >= everyMs;
}
