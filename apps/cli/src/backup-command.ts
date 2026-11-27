import { existsSync } from "node:fs";
import { AGENT_RISHI_VERSION } from "@agent-rishi/contracts";
import {
  backupDatabase,
  type DbBackup,
  dbBackupDir,
  homePaths,
  listDbBackups,
  restoreDatabase,
} from "@agent-rishi/server";
import { findRunningServer } from "./running";

function describe(b: DbBackup): string {
  const mb = (b.bytes / 1024 / 1024).toFixed(1);
  return `${b.name}  (${b.takenAt.toISOString()}, ${mb} MB)`;
}

/** `agent-rishi backup`: take a verified backup of the database now (the server may run). */
export async function backupCommand(home: string): Promise<number> {
  const paths = homePaths(home);
  if (!existsSync(paths.db)) {
    console.log(`There is no database to back up yet (${paths.db}).`);
    return 0;
  }
  const taken = await backupDatabase(paths.db, dbBackupDir(home), AGENT_RISHI_VERSION);
  console.log(`Backed up the database: ${describe(taken)}`);
  console.log(`Backups are in ${dbBackupDir(home)}`);
  return 0;
}

/**
 * `agent-rishi restore`: list the backups; `agent-rishi restore <name>`: put that one in place
 * of the database. Refuses while the server runs; the replaced database is kept aside.
 */
export async function restoreCommand(home: string, name: string | undefined): Promise<number> {
  const paths = homePaths(home);
  const dir = dbBackupDir(home);
  const backups = listDbBackups(dir);
  if (!name) {
    if (!backups.length) {
      console.log(`No database backups in ${dir}.`);
      return 0;
    }
    console.log(`Database backups, newest first (${dir}):`);
    for (const b of backups) console.log(`  ${describe(b)}`);
    console.log("\nRestore one with: agent-rishi restore <name>   (stop Agent Rishi first)");
    return 0;
  }
  if (await findRunningServer(paths.serverLock)) {
    console.error("Agent Rishi is running. Stop it first (agent-rishi stop), then restore.");
    return 1;
  }
  try {
    const { restored, setAside } = restoreDatabase(paths.db, dir, name);
    console.log(`Restored the database from ${describe(restored)}.`);
    if (setAside) console.log(`The database it replaced is kept as ${setAside}`);
    if (restored.version !== AGENT_RISHI_VERSION) {
      console.log(
        `It was taken by Agent Rishi ${restored.version}; ${AGENT_RISHI_VERSION} updates it when it starts.`,
      );
    }
    return 0;
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    return 1;
  }
}
