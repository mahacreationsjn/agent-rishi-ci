import { copyFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { OwnerId } from "@agent-rishi/contracts";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openDatabase } from "../src/db/client";
import { backupDatabase } from "../src/db/safety";
import { installOwner } from "../src/db/schema";
import { ensureLocalOwner } from "../src/services/owner";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "agent-rishi-owner-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("the install's owner", () => {
  it("is made once, on the first start, and kept afterwards", () => {
    const file = join(dir, "agent-rishi.db");
    const first = openDatabase(file);
    const made = ensureLocalOwner(first.db, () => new Date("2026-11-28T00:00:00.000Z"));
    expect(OwnerId.safeParse(made.id).success).toBe(true);
    expect(made.createdAt).toBe("2026-11-28T00:00:00.000Z");
    expect(ensureLocalOwner(first.db)).toEqual(made);
    first.close();

    const again = openDatabase(file);
    expect(ensureLocalOwner(again.db)).toEqual(made);
    expect(again.db.select().from(installOwner).all()).toHaveLength(1);
    again.close();
  });

  it("differs between installs", () => {
    const a = openDatabase(join(dir, "a.db"));
    const b = openDatabase(join(dir, "b.db"));
    expect(ensureLocalOwner(a.db).id).not.toBe(ensureLocalOwner(b.db).id);
    a.close();
    b.close();
  });

  it("comes back with a restored backup, so restored items keep their owner", async () => {
    const file = join(dir, "agent-rishi.db");
    const db = openDatabase(file);
    const owner = ensureLocalOwner(db.db);
    const taken = await backupDatabase(db.client, join(dir, "backups"), "0.8.0");
    db.close();
    const restoredFile = join(dir, "restored.db");
    copyFileSync(taken.file, restoredFile);
    const restored = openDatabase(restoredFile);
    expect(ensureLocalOwner(restored.db)).toEqual(owner);
    restored.close();
  });
});
