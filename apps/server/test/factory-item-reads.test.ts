import type { StatementSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { createFactoryEnv, type FactoryEnv } from "./support/factory-env";

let env: FactoryEnv;
afterEach(() => env?.close());

const enable = () =>
  env.factory.setMode(env.project.id, {
    mode: "software_factory",
    limits: env.project.factoryLimits,
  });
const tick = () => env.factory.tick(env.project.id);
const later = () => new Promise((r) => setTimeout(r, 5));

/** Items of the project for an issue, counted in the database. */
function itemsForIssue(number: number): number {
  const row = env.db.client
    .prepare(
      "select count(*) as n from factory_items where project_id = ? and json_extract(item, '$.issue.number') = ?",
    )
    .get(env.project.id, number) as { n: number };
  return row.n;
}

/** `count` finished items, newer than everything before (no issue of theirs is open). */
async function newerHistory(count: number): Promise<void> {
  await later();
  for (let n = 0; n < count; n++) {
    env.factory.data.createItem({
      projectId: env.project.id,
      workKey: `issue:${10_000 + n}`,
      title: `Shipped ${n}`,
      summary: "",
      source: "issue",
      stage: "merged",
      issue: {
        number: 10_000 + n,
        url: `https://github.com/acme/app/issues/${10_000 + n}`,
        title: "",
      },
      mergedAt: new Date(Date.now() - 3 * 24 * 60 * 60 * 1000).toISOString(),
      sessionsArchivedAt: new Date().toISOString(),
    });
  }
}

/** Count the rows read from `factory_items` (each one parsed from JSON) while it runs. */
async function itemRowsReadBy(
  run: () => Promise<unknown>,
): Promise<{ queries: number; rows: number }> {
  const client = env.db.client;
  const prepare = client.prepare.bind(client);
  const counts = { queries: 0, rows: 0 };
  client.prepare = ((sql: string) => {
    const stmt = prepare(sql);
    if (!/^\s*select\b/i.test(sql) || !/from\s+"factory_items"/i.test(sql)) return stmt;
    const all = stmt.all.bind(stmt);
    const get = stmt.get.bind(stmt);
    stmt.all = ((...params: Parameters<StatementSync["all"]>) => {
      const rows = all(...params);
      counts.queries += 1;
      counts.rows += rows.length;
      return rows;
    }) as StatementSync["all"];
    stmt.get = ((...params: Parameters<StatementSync["get"]>) => {
      const row = get(...params);
      counts.queries += 1;
      counts.rows += row ? 1 : 0;
      return row;
    }) as StatementSync["get"];
    return stmt;
  }) as typeof client.prepare;
  try {
    await run();
  } finally {
    Reflect.deleteProperty(client, "prepare");
  }
  return counts;
}

describe("factory work items past the newest 500 (#359)", () => {
  it("takes an open issue in once, however much newer work came after its item", async () => {
    env = createFactoryEnv();
    enable();
    // An untrusted author's issue: listed as ignored, nothing runs on it.
    const untrusted = env.gh.openIssue({
      projectId: env.project.id,
      title: "Add a webhook",
      author: "mallory",
    });
    // A trusted issue whose item was rejected while the issue stayed open.
    const rejected = env.gh.openIssue({
      projectId: env.project.id,
      title: "Rewrite the parser",
      author: "agent-rishi",
    });
    env.factory.data.createItem({
      projectId: env.project.id,
      workKey: `issue:${rejected.number}`,
      title: rejected.title,
      summary: "",
      source: "issue",
      stage: "rejected",
      issue: { number: rejected.number, url: rejected.url, title: rejected.title },
      reason: "Out of scope",
      finishedAt: new Date().toISOString(),
      sessionsArchivedAt: new Date().toISOString(),
    });
    const perIssue = () => ({
      untrusted: itemsForIssue(untrusted.number),
      rejected: itemsForIssue(rejected.number),
    });
    await tick();
    expect(perIssue()).toEqual({ untrusted: 1, rejected: 1 });

    await newerHistory(600);
    await tick();

    expect(perIssue()).toEqual({ untrusted: 1, rejected: 1 });
    expect(env.factory.data.items(env.project.id)).toHaveLength(602);
  });

  it("reads the work items once in an idle tick", async () => {
    env = createFactoryEnv();
    enable();
    await newerHistory(500);
    await tick();
    const total = (
      env.db.client
        .prepare("select count(*) as n from factory_items where project_id = ?")
        .get(env.project.id) as { n: number }
    ).n;

    const reads = await itemRowsReadBy(tick);

    expect(total).toBe(500);
    expect(reads).toEqual({ queries: 1, rows: total });
  });
});
