import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { findMigrationsDir } from "../src/db/client";

/** The parent drizzle-kit gives the first snapshot. */
const ROOT = "00000000-0000-0000-0000-000000000000";

interface Snapshot {
  /** The migration's folder name, `<14-digit timestamp>_<name>`. */
  folder: string;
  id: string;
  prevIds: string[];
}

const REGENERATE =
  "delete the newer migration's folder and run `pnpm db:generate` again on top of main";

/**
 * Every way the snapshot chain can stop being one line that drizzle-kit can generate on top of:
 * a fork (two migrations made from the same main, merged one after the other), a merge, a parent
 * that doesn't exist, more than one head, or a parent newer than its child (the runtime migrator
 * applies folders in timestamp order, so the chain must follow it). Empty when the chain is good.
 */
function chainProblems(snapshots: Snapshot[]): string[] {
  const problems: string[] = [];
  const byId = new Map<string, Snapshot>();
  for (const s of snapshots) {
    const other = byId.get(s.id);
    if (other) problems.push(`${s.folder} and ${other.folder} share the snapshot id ${s.id}`);
    byId.set(s.id, s);
  }
  const children = new Map<string, Snapshot[]>();
  for (const s of snapshots) {
    if (s.prevIds.length !== 1) {
      problems.push(
        `${s.folder} has ${s.prevIds.length} parents (${s.prevIds.join(", ")}); a snapshot needs exactly one: ${REGENERATE}`,
      );
    }
    for (const parentId of s.prevIds) {
      children.set(parentId, [...(children.get(parentId) ?? []), s]);
      if (parentId === ROOT) continue;
      const parent = byId.get(parentId);
      if (!parent) {
        problems.push(`${s.folder}: its parent snapshot ${parentId} does not exist`);
      } else if (parent.folder.slice(0, 14) >= s.folder.slice(0, 14)) {
        problems.push(`${s.folder} is not newer than its parent ${parent.folder}: ${REGENERATE}`);
      }
    }
  }
  for (const [parentId, kids] of children) {
    if (kids.length < 2) continue;
    const parent = parentId === ROOT ? "the start" : (byId.get(parentId)?.folder ?? parentId);
    problems.push(
      `the chain forks after ${parent} into ${kids.map((k) => k.folder).join(", ")}: ${REGENERATE}`,
    );
  }
  const heads = snapshots.filter((s) => !children.has(s.id));
  if (heads.length !== 1) {
    problems.push(
      `the chain has ${heads.length} heads (${heads.map((h) => h.folder).join(", ")}); it needs exactly one`,
    );
  }
  return problems;
}

function readSnapshots(dir: string): { snapshots: Snapshot[]; problems: string[] } {
  const snapshots: Snapshot[] = [];
  const problems: string[] = [];
  for (const folder of readdirSync(dir).filter((n) => /^\d{14}_/.test(n))) {
    const file = join(dir, folder, "snapshot.json");
    if (!existsSync(file)) {
      problems.push(`${folder} has no snapshot.json`);
      continue;
    }
    const { id, prevIds } = JSON.parse(readFileSync(file, "utf8")) as Snapshot;
    snapshots.push({ folder, id, prevIds });
  }
  return { snapshots, problems };
}

/** A fixture snapshot whose id is its folder name. */
const snap = (folder: string, ...prevIds: string[]): Snapshot => ({ folder, id: folder, prevIds });
const A = "20260101000000_a";
const B = "20260102000000_b";
const C = "20260103000000_c";

describe("migration snapshot chain", () => {
  it("is one line with one head, in timestamp order", () => {
    const { snapshots, problems } = readSnapshots(findMigrationsDir());
    expect(snapshots.length).toBeGreaterThan(1);
    expect([...problems, ...chainProblems(snapshots)]).toEqual([]);
  });

  it("accepts a straight chain", () => {
    expect(chainProblems([snap(A, ROOT), snap(B, A), snap(C, B)])).toEqual([]);
  });

  it("rejects two migrations made from the same parent", () => {
    const D = "20260104000000_d";
    expect(chainProblems([snap(A, ROOT), snap(B, A), snap(C, B), snap(D, B)])).toEqual([
      expect.stringContaining(`forks after ${B} into ${C}, ${D}`),
      expect.stringContaining(`2 heads (${C}, ${D})`),
    ]);
  });

  it("rejects a parent that does not exist", () => {
    expect(chainProblems([snap(A, ROOT), snap(B, "gone")])).toEqual([
      `${B}: its parent snapshot gone does not exist`,
      expect.stringContaining("2 heads"),
    ]);
  });

  it("rejects a merge of two parents", () => {
    expect(chainProblems([snap(A, ROOT), snap(B, A), snap(C, A, B)])).toEqual([
      expect.stringContaining(`${C} has 2 parents`),
      expect.stringContaining(`forks after ${A} into ${B}, ${C}`),
    ]);
  });

  it("rejects a child older than its parent", () => {
    expect(chainProblems([snap(B, ROOT), snap(A, B)])).toEqual([
      expect.stringContaining(`${A} is not newer than its parent ${B}`),
    ]);
  });
});
