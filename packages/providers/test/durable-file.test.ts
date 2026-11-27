import * as fs from "node:fs";
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { writeFileDurably } from "../src/util/durable-file";

const real = vi.hoisted(
  () => ({}) as { fsyncSync?: typeof fs.fsyncSync; renameSync?: typeof fs.renameSync },
);

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  real.fsyncSync = actual.fsyncSync;
  real.renameSync = actual.renameSync;
  return { ...actual, fsyncSync: vi.fn(actual.fsyncSync), renameSync: vi.fn(actual.renameSync) };
});

describe("writeFileDurably", () => {
  let dir: string;
  afterEach(() => {
    vi.mocked(fs.fsyncSync).mockImplementation((fd) => real.fsyncSync?.(fd));
    vi.mocked(fs.renameSync).mockImplementation((from, to) => real.renameSync?.(from, to));
    rmSync(dir, { recursive: true, force: true });
  });
  const fresh = () => {
    dir = mkdtempSync(join(tmpdir(), "agent-rishi-durable-"));
    return dir;
  };

  it("writes a new file, creating its folder, and leaves no temporary file", () => {
    const file = join(fresh(), "nested", "settings.json");
    writeFileDurably(file, '{"a":1}\n');
    expect(readFileSync(file, "utf8")).toBe('{"a":1}\n');
    expect(readdirSync(join(dir, "nested"))).toEqual(["settings.json"]);
  });

  it("replaces an existing file and writes bytes as given", () => {
    const file = join(fresh(), "state.bin");
    writeFileSync(file, "old");
    writeFileDurably(file, new Uint8Array([1, 2, 3]));
    expect([...readFileSync(file)]).toEqual([1, 2, 3]);
  });

  it("flushes the data to disk before renaming it into place", () => {
    const order: string[] = [];
    vi.mocked(fs.fsyncSync).mockImplementation((fd) => {
      order.push("fsync");
      real.fsyncSync?.(fd);
    });
    vi.mocked(fs.renameSync).mockImplementation((from, to) => {
      order.push("rename");
      real.renameSync?.(from, to);
    });
    writeFileDurably(join(fresh(), "f.json"), "{}");
    expect(order[0]).toBe("fsync");
    expect(order).toContain("rename");
  });

  it.skipIf(process.platform === "win32")("creates a new file with the mode asked for", () => {
    const file = join(fresh(), "secret.json");
    writeFileDurably(file, "{}", { mode: 0o600 });
    expect(statSync(file).mode & 0o777).toBe(0o600);
  });

  it("leaves the old file and no temporary file when the rename fails", () => {
    const file = join(fresh(), "keep.json");
    writeFileSync(file, "old");
    vi.mocked(fs.renameSync).mockImplementation(() => {
      throw new Error("disk full");
    });
    expect(() => writeFileDurably(file, "new")).toThrow("disk full");
    expect(readFileSync(file, "utf8")).toBe("old");
    expect(readdirSync(dir)).toEqual(["keep.json"]);
  });
});
