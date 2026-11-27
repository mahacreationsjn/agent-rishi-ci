import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  backupDatabase,
  checkDatabaseFile,
  DatabaseDamagedError,
  dbBackupDue,
  listDbBackups,
  prepareDatabase,
  restoreDatabase,
} from "../src/db/safety";

let home: string;
let dbFile: string;
let dir: string;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "agent-rishi-db-safety-"));
  dbFile = join(home, "agent-rishi.db");
  dir = join(home, "backups", "db");
});
afterEach(() => rmSync(home, { recursive: true, force: true }));

/** A small database in WAL mode with `rows` rows, closed. */
function makeDb(file: string, rows: number): void {
  const db = new DatabaseSync(file);
  db.exec("PRAGMA journal_mode = WAL; CREATE TABLE IF NOT EXISTS t (n INTEGER);");
  const insert = db.prepare("INSERT INTO t (n) VALUES (?)");
  for (let i = 0; i < rows; i++) insert.run(i);
  db.close();
}

function countRows(file: string): number {
  const db = new DatabaseSync(file);
  const { c } = db.prepare("SELECT count(*) AS c FROM t").get() as { c: number };
  db.close();
  return c;
}

/** What a power cut did to files on the development machine: same size, all zeros. */
function zeroFill(file: string): void {
  writeFileSync(file, Buffer.alloc(statSync(file).size));
}

const at = (iso: string) => new Date(iso);

describe("checkDatabaseFile", () => {
  it("finds nothing wrong with a sound database", () => {
    makeDb(dbFile, 5);
    expect(checkDatabaseFile(dbFile)).toEqual([]);
  });

  it("reports a zero-filled file", () => {
    makeDb(dbFile, 5);
    zeroFill(dbFile);
    expect(checkDatabaseFile(dbFile).length).toBeGreaterThan(0);
  });
});

describe("backups", () => {
  it("takes a verified copy that holds the data, named by time and version", async () => {
    makeDb(dbFile, 42);
    const taken = await backupDatabase(dbFile, dir, "0.8.0", {
      now: at("2026-11-27T12:00:00.000Z"),
    });
    expect(taken.name).toBe("agent-rishi-20261127T120000Z-v0.8.0.db");
    expect(countRows(taken.file)).toBe(42);
    expect(readdirSync(dir)).toEqual([taken.name]);
  });

  it("copies from an open connection while it is in use", async () => {
    makeDb(dbFile, 3);
    const live = new DatabaseSync(dbFile);
    live.exec("INSERT INTO t (n) VALUES (99)");
    const taken = await backupDatabase(live, dir, "0.8.0");
    expect(live.isOpen).toBe(true);
    live.close();
    expect(countRows(taken.file)).toBe(4);
  });

  it("lists them newest first and keeps only the newest ones", async () => {
    makeDb(dbFile, 1);
    for (let day = 1; day <= 4; day++) {
      await backupDatabase(dbFile, dir, "0.8.0", {
        now: at(`2026-11-0${day}T10:00:00.000Z`),
        keep: 3,
      });
    }
    writeFileSync(join(dir, "notes.txt"), "not a backup");
    expect(listDbBackups(dir).map((b) => b.takenAt.toISOString())).toEqual([
      "2026-11-04T10:00:00.000Z",
      "2026-11-03T10:00:00.000Z",
      "2026-11-02T10:00:00.000Z",
    ]);
  });

  it("is due when the newest backup is a day old, or there is none", async () => {
    expect(dbBackupDue(dir)).toBe(true);
    makeDb(dbFile, 1);
    await backupDatabase(dbFile, dir, "0.8.0", { now: at("2026-11-27T00:00:00.000Z") });
    expect(dbBackupDue(dir, at("2026-11-27T23:00:00.000Z"))).toBe(false);
    expect(dbBackupDue(dir, at("2026-11-28T00:00:00.000Z"))).toBe(true);
  });

  it("keeps no file when the source can't be backed up", async () => {
    makeDb(dbFile, 1);
    zeroFill(dbFile);
    await expect(backupDatabase(dbFile, dir, "0.8.0")).rejects.toThrow();
    expect(readdirSync(dir)).toEqual([]);
  });
});

describe("prepareDatabase (server start)", () => {
  const prepare = (version: string, uncleanShutdown = false) =>
    prepareDatabase({ file: dbFile, backupDir: dir, version, uncleanShutdown });

  it("does nothing on a first start without a database", async () => {
    expect(await prepare("0.8.0")).toBeUndefined();
    expect(existsSync(dir)).toBe(false);
  });

  it("backs up once per version: before the first start, and before an upgrade migrates", async () => {
    makeDb(dbFile, 2);
    expect((await prepare("0.8.0"))?.version).toBe("0.8.0");
    expect(await prepare("0.8.0")).toBeUndefined();
    expect((await prepare("0.9.0"))?.version).toBe("0.9.0");
    expect(listDbBackups(dir)).toHaveLength(2);
  });

  it("checks after an unclean shutdown and starts on a sound database", async () => {
    makeDb(dbFile, 2);
    await prepare("0.8.0");
    await expect(prepare("0.8.0", true)).resolves.toBeUndefined();
  });

  it("refuses a damaged database after an unclean shutdown, naming the newest backup", async () => {
    makeDb(dbFile, 2);
    const taken = await prepare("0.8.0");
    zeroFill(dbFile);
    const error = await prepare("0.8.0", true).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(DatabaseDamagedError);
    expect((error as Error).message).toContain(`agent-rishi restore ${taken?.name}`);
    // Nothing was changed: the damaged file is still there, and no new backup was taken.
    expect(statSync(dbFile).size).toBeGreaterThan(0);
    expect(listDbBackups(dir)).toHaveLength(1);
  });
});

describe("restoreDatabase", () => {
  it("puts the backup in place and keeps the replaced database aside with its -wal and -shm", async () => {
    makeDb(dbFile, 7);
    const taken = await backupDatabase(dbFile, dir, "0.8.0");
    makeDb(dbFile, 5); // more rows after the backup
    writeFileSync(`${dbFile}-wal`, "wal");
    writeFileSync(`${dbFile}-shm`, "shm");
    const now = at("2026-11-27T13:00:00.000Z");
    const { setAside } = restoreDatabase(dbFile, dir, taken.name, now);
    expect(setAside).toBe(`${dbFile}.before-restore-20261127T130000Z`);
    expect(existsSync(`${setAside}-wal`)).toBe(true);
    expect(existsSync(`${setAside}-shm`)).toBe(true);
    expect(existsSync(`${dbFile}-wal`)).toBe(false);
    expect(countRows(dbFile)).toBe(7);
    expect(countRows(setAside as string)).toBe(12);
  });

  it("changes nothing for a backup that doesn't exist or fails its check", async () => {
    makeDb(dbFile, 1);
    expect(() => restoreDatabase(dbFile, dir, "agent-rishi-20260101T000000Z-v0.1.0.db")).toThrow(
      /No backup named/,
    );
    const taken = await backupDatabase(dbFile, dir, "0.8.0");
    zeroFill(taken.file);
    expect(() => restoreDatabase(dbFile, dir, taken.name)).toThrow(/failed its check/);
    expect(countRows(dbFile)).toBe(1);
    mkdirSync(dir, { recursive: true });
    expect(readdirSync(home).filter((f) => f.includes("before-restore"))).toEqual([]);
  });
});
