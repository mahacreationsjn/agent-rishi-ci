import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import {
  type Attachment,
  type ItemRecord,
  MAX_ATTACHMENT_BYTES,
  type UserInput,
} from "@agent-rishi/contracts";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type Database, openDatabase } from "../src/db/client";
import { EventStore } from "../src/events/store";
import { safeFileName } from "../src/services/artifact-names";
import { ArtifactService } from "../src/services/artifacts";
import { clientInput, clientItemRecord } from "../src/services/sessions/client-items";
import { sampleSession } from "./helpers";
import { removeTree } from "./support/remove-tree";

let dir: string;
let artifactsDir: string;
let database: Database;
let artifacts: ArtifactService;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "agent-rishi-file-attach-"));
  artifactsDir = join(dir, "artifacts");
  database = openDatabase(join(dir, "agent-rishi.db"));
  const store = new EventStore(database.db);
  store.append([{ type: "session.created", sessionId: "s1", payload: { session: sampleSession } }]);
  artifacts = new ArtifactService(database.db, store, artifactsDir);
});

afterEach(async () => {
  database.close();
  await removeTree(dir);
});

const owner = { sessionId: "s1", projectId: null };
const b64 = (text: string) => Buffer.from(text).toString("base64");

/** A file as the browser sends it: its bytes, with its name as the path. */
const uploaded = (name: string, text: string, path = name): Attachment => ({
  type: "file",
  path,
  name,
  mediaType: "application/pdf",
  source: { type: "base64", data: b64(text) },
});

const fileAt = (input: UserInput, i = 0) => {
  const a = input.attachments[i];
  if (a?.type !== "file") throw new Error("not a file attachment");
  return a;
};

describe("file attachments with their bytes", () => {
  it("stores them in the session's artifacts folder and gives the runner the absolute path", () => {
    const sent: UserInput = { text: "read it", attachments: [uploaded("отчёт 報告.pdf", "%PDF")] };
    const stored = artifacts.externalizeAttachments(sent, owner);
    const file = fileAt(stored);
    expect(file.source?.type).toBe("artifact");
    expect(file.path).toBe("отчёт 報告.pdf");
    expect(JSON.stringify(stored)).not.toContain(b64("%PDF"));
    expect(JSON.stringify(stored)).not.toContain(dir.replace(/\\/g, "\\\\"));

    const forRunner = fileAt(artifacts.resolveAttachments(stored, owner));
    expect(forRunner.source).toBeUndefined();
    expect(forRunner.name).toBe("отчёт 報告.pdf");
    expect(basename(forRunner.path)).toBe("отчёт 報告.pdf");
    expect(dirname(dirname(forRunner.path))).toBe(artifacts.sessionDir("s1"));
    expect(readFileSync(forRunner.path, "utf8")).toBe("%PDF");
    expect(artifacts.artifactForFile(forRunner.path)?.name).toBe("отчёт 報告.pdf");
  });

  it("never reads the path the browser sent, only writes the bytes it received", () => {
    const secret = join(dir, "secret.txt");
    writeFileSync(secret, "TOP SECRET");
    const sent: UserInput = {
      text: "x",
      attachments: [uploaded("../../secret.txt", "harmless", secret)],
    };
    const stored = artifacts.externalizeAttachments(sent, owner);
    const forRunner = fileAt(artifacts.resolveAttachments(stored, owner));
    expect(forRunner.path).not.toBe(secret);
    expect(forRunner.path.startsWith(artifacts.sessionDir("s1"))).toBe(true);
    expect(basename(forRunner.path)).toBe("secret.txt");
    expect(readFileSync(forRunner.path, "utf8")).toBe("harmless");
    expect(readFileSync(secret, "utf8")).toBe("TOP SECRET");
  });

  it("maps the path the provider echoes back to the artifact, never a path to the browser", () => {
    const sent: UserInput = { text: "x", attachments: [uploaded("notes.md", "# hi")] };
    const stored = artifacts.externalizeAttachments(sent, owner);
    const resolved = artifacts.resolveAttachments(stored, owner);
    expect(clientInput(resolved, artifacts)).toEqual(stored);

    const other: UserInput = {
      text: "y",
      attachments: [{ type: "file", path: join(dir, "wt", "p", "spec.md") }],
    };
    const record: ItemRecord = {
      sessionId: "s1",
      threadId: "t1",
      turnId: "u1",
      position: 0,
      createdAt: "2026-11-23T10:00:00.000Z",
      updatedAt: "2026-11-23T10:00:00.000Z",
      item: { id: "i1", kind: "user_message", status: "completed", input: resolved },
    };
    const json = JSON.stringify([
      clientItemRecord(record, artifacts),
      clientInput(other, artifacts),
    ]);
    expect(json).not.toContain(JSON.stringify(dir).slice(1, -1));
    expect(json).toContain("spec.md");
  });

  it("keeps old messages with a bare path as they are", () => {
    const legacy: UserInput = { text: "x", attachments: [{ type: "file", path: "report.pdf" }] };
    expect(artifacts.externalizeAttachments(legacy, owner)).toBe(legacy);
    expect(artifacts.resolveAttachments(legacy, owner)).toBe(legacy);
    expect(clientInput(legacy, artifacts)).toBe(legacy);
  });

  it("resolves only the session's own artifacts and its project's shared ones", () => {
    const mine = artifacts.externalizeAttachments(
      { text: "x", attachments: [uploaded("mine.txt", "s1 only")] },
      owner,
    );
    expect(() => artifacts.resolveAttachments(mine, { sessionId: "s2", projectId: null })).toThrow(
      /No artifact/,
    );
    // A conflicting start's files sit in `shared/`, for the session that start becomes.
    const shared = artifacts.externalizeAttachments(
      { text: "x", attachments: [uploaded("spec.txt", "shared")] },
      { sessionId: null, projectId: "p1" },
    );
    const started = fileAt(
      artifacts.resolveAttachments(shared, { sessionId: "s3", projectId: "p1" }),
    );
    expect(readFileSync(started.path, "utf8")).toBe("shared");
    for (const other of ["p2", null]) {
      expect(() =>
        artifacts.resolveAttachments(shared, { sessionId: "s3", projectId: other }),
      ).toThrow(/No artifact/);
    }
  });

  it("refuses a file over 20 MB", () => {
    const big = Buffer.alloc(MAX_ATTACHMENT_BYTES + 1).toString("base64");
    const sent: UserInput = {
      text: "x",
      attachments: [{ type: "file", path: "big.bin", source: { type: "base64", data: big } }],
    };
    expect(() => artifacts.externalizeAttachments(sent, owner)).toThrow(/larger than 20 MB/);
  });
});

describe("safeFileName", () => {
  it("keeps only the last segment and drops what file systems refuse", () => {
    expect(safeFileName("../../etc/passwd")).toBe("passwd");
    expect(safeFileName("..\\..\\boot.ini")).toBe("boot.ini");
    expect(safeFileName('a:b*c?"d<e>|f.txt')).toBe("a_b_c__d_e__f.txt");
    expect(safeFileName("tab\there\u0000.txt")).toBe("tab_here_.txt");
    expect(safeFileName("invoice‮fdp.exe")).toBe("invoice_fdp.exe");
    expect(safeFileName("trailing. . ")).toBe("trailing");
    expect(safeFileName("..")).toBe("attachment");
    expect(safeFileName("")).toBe("attachment");
    expect(safeFileName(".env")).toBe(".env");
  });

  it("guards Windows device names", () => {
    expect(safeFileName("CON")).toBe("_CON");
    expect(safeFileName("nul.txt")).toBe("_nul.txt");
    expect(safeFileName("com1.log")).toBe("_com1.log");
    expect(safeFileName("aux .txt")).toBe("_aux .txt");
    expect(safeFileName("CONOUT$")).toBe("_CONOUT$");
    expect(safeFileName("console.log")).toBe("console.log");
  });

  it("keeps names in any script, and cuts long ones on a character boundary", () => {
    expect(safeFileName("Résumé – 履歴書.docx")).toBe("Résumé – 履歴書.docx");
    const long = safeFileName(`${"報".repeat(100)}.pdf`);
    expect(long.endsWith(".pdf")).toBe(true);
    expect(Buffer.byteLength(long)).toBeLessThanOrEqual(120);
    expect(long).not.toContain("�");
  });
});
