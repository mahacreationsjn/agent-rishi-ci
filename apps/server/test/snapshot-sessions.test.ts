import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ArchivedSessionsPage,
  FactoryLimits,
  type NewEvent,
  Project,
  SESSION_LOOKUP_MAX,
  type Session,
  SNAPSHOT_ARCHIVED_SESSIONS_MAX,
  Snapshot,
} from "@agent-rishi/contracts";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type RunningServer, startServer } from "../src";
import { sampleSession } from "./helpers";
import { removeTree } from "./support/remove-tree";

const TOKEN = "t".repeat(64);
const auth = { authorization: `Bearer ${TOKEN}` };
const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
let home: string;
let server: RunningServer;

beforeEach(async () => {
  home = mkdtempSync(join(tmpdir(), "agent-rishi-snapshot-"));
  server = await startServer({
    port: 0,
    dataDir: home,
    token: TOKEN,
    runner: false,
    secrets: "memory",
    checkSetupOnStart: false,
  });
});

afterEach(async () => {
  await server.close();
  await removeTree(home);
});

const iso = (msAgo: number) => new Date(Date.now() - msAgo).toISOString();

function project(id: string): Project {
  return Project.parse({
    id,
    kind: "local",
    name: id,
    slug: id,
    path: join(home, id),
    defaultBranch: "main",
    defaultProvider: "fake",
    defaultModel: null,
    defaultEffort: null,
    autonomy: null,
    autonomyMode: "assisted",
    visionPath: ".agent-rishi/VISION.md",
    factoryLimits: FactoryLimits.parse({}),
    killSwitch: false,
    timezone: null,
    agentCiEnv: true,
    execution: { backend: "local" },
    pinned: false,
    sortOrder: 0,
    createdAt: iso(90 * DAY),
    updatedAt: iso(90 * DAY),
    archivedAt: null,
  });
}

/** Session `s<i>` in project p1, created `i` minutes after a start 60 days ago. */
function session(i: number, archivedMsAgo: number | null, patch: Partial<Session> = {}): Session {
  const at = new Date(Date.now() - 60 * DAY + i * 60_000).toISOString();
  return {
    ...sampleSession,
    id: `s${String(i).padStart(4, "0")}`,
    projectId: "p1",
    workKey: `request:${i}`,
    status: archivedMsAgo === null ? "idle" : "completed",
    createdAt: at,
    updatedAt: at,
    archivedAt: archivedMsAgo === null ? null : iso(archivedMsAgo),
    ...patch,
  };
}

function seed(list: Session[]): void {
  server.store.append([
    { type: "project.created", sessionId: null, payload: { project: project("p1") } },
    { type: "project.created", sessionId: null, payload: { project: project("p2") } },
    ...list.map(
      (s): NewEvent => ({ type: "session.created", sessionId: s.id, payload: { session: s } }),
    ),
  ]);
}

async function get(path: string): Promise<Response> {
  return fetch(`${server.url}/api${path}`, { headers: auth });
}

async function snapshot(): Promise<Snapshot> {
  return Snapshot.parse(await (await get("/snapshot")).json());
}

describe("GET /api/snapshot", () => {
  it("carries the active sessions, not every archived session ever", async () => {
    // A busy factory: a few sessions in play, and a long tail of finished ones it archived.
    const all = Array.from({ length: 300 }, (_, i) => session(i, i % 100 === 0 ? null : 30 * DAY));
    seed(all);

    const snap = await snapshot();

    expect(snap.sessions.map((s) => s.id)).toEqual(["s0000", "s0100", "s0200"]);
  });

  it("keeps the recently archived sessions, the newest few, oldest created first", async () => {
    const extra = 5;
    seed([
      session(0, null),
      // Archived within the window: all but the `extra` archived longest ago fit the cap.
      ...Array.from({ length: SNAPSHOT_ARCHIVED_SESSIONS_MAX + extra }, (_, i) =>
        session(i + 1, (i + 1) * 60_000),
      ),
      session(500, 8 * DAY),
      session(501, null, { role: "pm" }),
    ]);

    const ids = (await snapshot()).sessions.map((s) => s.id);

    const recent = Array.from(
      { length: SNAPSHOT_ARCHIVED_SESSIONS_MAX },
      (_, i) => session(i + 1, 0).id,
    );
    expect(ids).toEqual(["s0000", ...recent, "s0501"]);
  });

  it("counts every project's archived agent and PM sessions, the old ones included", async () => {
    seed([
      session(0, null),
      session(1, HOUR),
      session(2, 30 * DAY),
      session(3, 400 * DAY),
      session(4, 30 * DAY, { role: "pm" }),
      session(5, 30 * DAY, { projectId: "p2" }),
      session(6, null, { projectId: "p2" }),
      session(7, 30 * DAY, { projectId: null }),
      session(8, 30 * DAY, { role: "orchestrator", projectId: null }),
    ]);

    // The PM's earlier conversation (s0004) is listed with the agents (§8.1).
    expect((await snapshot()).archivedSessionCounts).toEqual({ p1: 4, p2: 1 });
  });
});

describe("GET /api/sessions?ids=", () => {
  it("looks up sessions by id, the ones archived long ago included", async () => {
    seed([session(0, null), session(1, 30 * DAY), session(2, 400 * DAY), session(3, HOUR)]);

    const res = await get("/sessions?ids=s0002,s0000,nope,s0001");

    expect(res.status).toBe(200);
    const ids = ((await res.json()) as Session[]).map((s) => s.id).sort();
    expect(ids).toEqual(["s0000", "s0001", "s0002"]);
  });

  it("refuses more ids than one lookup takes", async () => {
    const ids = Array.from({ length: SESSION_LOOKUP_MAX + 1 }, (_, i) => `s${i}`).join(",");
    expect((await get(`/sessions?ids=${ids}`)).status).toBe(400);
    expect((await get("/sessions?ids=")).status).toBe(400);
  });
});

describe("GET /api/projects/:id/sessions/archived", () => {
  it("pages through a project's archived agent and PM sessions, most recently archived first", async () => {
    // s0004 and s0005 were archived in the same instant: the id breaks the tie.
    const tie = { archivedAt: iso(2 * HOUR) };
    seed([
      session(0, null),
      session(1, 3 * HOUR),
      session(2, 1 * HOUR),
      session(3, 40 * DAY),
      session(4, 0, tie),
      session(5, 0, tie),
      session(6, HOUR, { role: "pm" }),
      session(7, HOUR, { projectId: "p2" }),
    ]);

    const pages: string[][] = [];
    let cursor: string | null = null;
    do {
      const query: string = cursor ? `&cursor=${encodeURIComponent(cursor)}` : "";
      const res = await get(`/projects/p1/sessions/archived?limit=2${query}`);
      expect(res.status).toBe(200);
      const page = ArchivedSessionsPage.parse(await res.json());
      pages.push(page.sessions.map((s) => s.id));
      cursor = page.nextCursor;
    } while (cursor && pages.length < 10);

    // The PM's earlier conversation (s0006) is listed with the agents (§8.1).
    expect(pages).toEqual([
      ["s0006", "s0002"],
      ["s0005", "s0004"],
      ["s0001", "s0003"],
    ]);
  });

  it("refuses an unknown project and a bad cursor", async () => {
    seed([session(1, HOUR)]);
    expect((await get("/projects/nope/sessions/archived")).status).toBe(404);
    expect((await get("/projects/p1/sessions/archived?cursor=garbage")).status).toBe(400);
    expect((await get("/projects/p1/sessions/archived?limit=500")).status).toBe(400);
  });
});
