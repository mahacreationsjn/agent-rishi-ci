import { ReviewVerdict } from "@agent-rishi/contracts";
import { describe, expect, it } from "vitest";
import { ServiceError } from "../src/services/errors";
import { settleApproval, verdictHead } from "../src/services/factory/approval";
import { type PatchedFile, prDiffKey } from "../src/services/factory/diff-key";
import { GithubFactoryPort } from "../src/services/factory/github-port";
import { recheckOf } from "../src/services/factory/recheck";
import type { GithubService } from "../src/services/github/github-service";
import { APPROVE } from "./support/factory-steps";

/**
 * The fingerprint of what a PR itself changes (#322): an approval carries over to a new head
 * only when it is the same, so it must not move when main only shifts the PR's hunks, and must
 * move on any change to the PR's own lines.
 */

const file = (patch: string | null, extra: Partial<PatchedFile> = {}): PatchedFile => ({
  path: "src/fetch.ts",
  status: "modified",
  patch,
  ...extra,
});

const PATCH = [
  "diff --git a/src/fetch.ts b/src/fetch.ts",
  "--- a/src/fetch.ts",
  "+++ b/src/fetch.ts",
  "@@ -10,6 +10,7 @@ export function get(url) {",
  "   const u = new URL(url);",
  "+  assertPublic(u);",
  "   return fetch(u);",
].join("\n");

describe("prDiffKey", () => {
  it("stays the same when only the hunks' positions moved, in any file order", () => {
    const moved = PATCH.replace(
      "@@ -10,6 +10,7 @@ export function get(url) {",
      "@@ -42,6 +43,7 @@",
    );
    const other = file("@@ -1 +1 @@\n-a\n+b", { path: "src/a.ts" });
    expect(prDiffKey([file(PATCH), other], 2)).toBe(prDiffKey([other, file(moved)], 2));
  });

  it("changes with the PR's own lines, the lines around them, a status or a rename", () => {
    const key = prDiffKey([file(PATCH)], 1);
    expect(key).toMatch(/^[0-9a-f]{24}$/);
    expect(prDiffKey([file(PATCH.replace("assertPublic", "noop"))], 1)).not.toBe(key);
    expect(prDiffKey([file(PATCH.replace("return fetch", "return get"))], 1)).not.toBe(key);
    expect(prDiffKey([file(PATCH, { status: "added" })], 1)).not.toBe(key);
    expect(prDiffKey([file(PATCH, { previousPath: "src/old.ts" })], 1)).not.toBe(key);
    expect(prDiffKey([file(PATCH), file("@@ -0,0 +1 @@\n+x", { path: "b.ts" })], 2)).not.toBe(key);
  });

  it("can't tell without every file, or a file's patch or blob", () => {
    expect(prDiffKey([file(PATCH), file(null, { path: "logo.png" })], 2)).toBeNull();
    expect(prDiffKey([file(PATCH)], 3001)).toBeNull();
  });
});

/** A blob sha at the PR's head, as GitHub lists it per file. */
const blob = (c: string) => c.repeat(40);
const SNAPSHOT_PATH = "apps/server/drizzle/20261115071050_turn_kind/snapshot.json";

/**
 * A file GitHub sends no patch for (too large, binary; every migration's `snapshot.json`, #456)
 * is fingerprinted by its blob at the head, so an update-branch that leaves it alone keeps the
 * approval, and any change to its content owes a re-check.
 */
describe("prDiffKey with a file GitHub sends no patch for", () => {
  const snapshot = (sha: string | null) =>
    file(null, { path: SNAPSHOT_PATH, status: "added", sha });
  const moved = PATCH.replace("@@ -10,6 +10,7 @@ export function get(url) {", "@@ -42,6 +43,7 @@");

  it("tells an added one by its blob: the same key before and after an update-branch", () => {
    const before = prDiffKey([file(PATCH), snapshot(blob("a"))], 2);
    expect(before).toMatch(/^[0-9a-f]{24}$/);
    expect(prDiffKey([snapshot(blob("a")), file(moved)], 2)).toBe(before);
  });

  it("changes the key when its content (blob) changes", () => {
    const key = prDiffKey([file(PATCH), snapshot(blob("a"))], 2);
    expect(key).not.toBeNull();
    expect(prDiffKey([file(PATCH), snapshot(blob("b"))], 2)).not.toBe(key);
  });

  it("gives a modified or renamed one a key that moves with its content at the head", () => {
    const at = (sha: string, extra: Partial<PatchedFile>) =>
      prDiffKey([file(PATCH), file(null, { path: "assets/logo.png", sha, ...extra })], 2);
    for (const extra of [
      { status: "modified" },
      { status: "renamed", previousPath: "assets/old-logo.png" },
    ]) {
      const key = at(blob("a"), extra);
      expect(key).toMatch(/^[0-9a-f]{24}$/);
      expect(at(blob("a"), extra)).toBe(key);
      expect(at(blob("b"), extra)).not.toBe(key);
    }
  });

  it("still can't tell from a file list GitHub cut short, or without its blob", () => {
    expect(prDiffKey([file(PATCH), snapshot(blob("a"))], 3001)).toBeNull();
    expect(prDiffKey([file(PATCH), snapshot(null)], 2)).toBeNull();
  });
});

/** One entry of GitHub's compare `files`. */
interface CompareFile {
  filename: string;
  status: string;
  patch?: string;
  sha?: string | null;
}

const AT_A: CompareFile[] = [
  { filename: "src/fetch.ts", status: "modified", patch: "@@ -1 +1 @@\n-a\n+b" },
];
const AT_B: CompareFile[] = [
  ...AT_A,
  { filename: "src/net.ts", status: "added", patch: "@@ -0,0 +1 @@\n+exfiltrate()" },
];
const keyOf = (files: CompareFile[]) =>
  prDiffKey(
    files.map((f) => ({ path: f.filename, status: f.status, patch: f.patch ?? null })),
    files.length,
  );

/**
 * A GitHub whose PR read says head `A` while its file listing already shows a push (B): the two
 * are separate requests, and a push can land between them. Compares answer per commit.
 */
function racingGithub(filesAt: Record<string, CompareFile[] | Error>, headSha = "A") {
  const compares: string[] = [];
  const github = {
    githubRepo: () => ({ owner: "acme", repo: "app", defaultBranch: "main" }),
    getPrDetails: async () => ({
      number: 7,
      url: "https://github.com/acme/app/pull/7",
      state: "open",
      title: "Harden fetch",
      body: "",
      headSha,
      headBranch: "agent-rishi/fetch",
      baseBranch: "main",
      checks: { state: "success", checks: [] },
      mergeable: "mergeable",
      mergeState: "clean",
      additions: 2,
      deletions: 1,
      changedFiles: AT_B.length,
      // The listing was read after B landed.
      files: AT_B.map((f) => ({ path: f.filename, status: f.status, additions: 1, deletions: 0 })),
    }),
    client: {
      run: async (fn: (octokit: unknown) => Promise<unknown>) =>
        fn({
          rest: {
            repos: {
              compareCommitsWithBasehead: async ({ basehead }: { basehead: string }) => {
                compares.push(basehead);
                const at = filesAt[basehead.split("...")[1] ?? ""];
                if (at === undefined) throw new ServiceError(404, "github_not_found", "Not Found");
                if (at instanceof Error) throw at;
                return { data: { files: at } };
              },
            },
          },
        }),
    },
  } as unknown as GithubService;
  return { port: new GithubFactoryPort(github), compares };
}

describe("the fingerprint the factory reads", () => {
  it("is pinned to the head commit it is filed under, never a push that came between reads", async () => {
    const { port, compares } = racingGithub({ A: AT_A, B: AT_B });
    const pr = await port.prDetails("p-app", 7);
    expect(pr.headSha).toBe("A");
    expect(compares).toEqual(["main...A"]);
    expect(pr.diffKey).toBe(keyOf(AT_A));
    expect(pr.diffKey).not.toBe(keyOf(AT_B));
    // A commit's own change never changes: read once per head.
    await port.prDetails("p-app", 7);
    expect(compares).toEqual(["main...A"]);
  });

  it("can't tell (null) when GitHub doesn't know the commit or lists too many files", async () => {
    expect((await racingGithub({}).port.prDetails("p-app", 7)).diffKey).toBeNull();
    const many = Array.from({ length: 300 }, (_, i) => ({
      filename: `f${i}.ts`,
      status: "modified",
      patch: "@@ -1 +1 @@\n-a\n+b",
    }));
    expect((await racingGithub({ A: many }).port.prDetails("p-app", 7)).diffKey).toBeNull();
  });

  it("throws when GitHub doesn't answer properly, so the PR is read again later", async () => {
    const limited = new ServiceError(503, "github_rate_limited", "rate limited");
    await expect(racingGithub({ A: limited }).port.prDetails("p-app", 7)).rejects.toThrow(
      /rate limited/,
    );
  });

  it("keeps a PR with a migration approved across an update-branch (PR #440, #456)", async () => {
    // GitHub sends no patch for the migration's snapshot.json, and one for every other file.
    const snapshot: CompareFile = { filename: SNAPSHOT_PATH, status: "added", sha: blob("5") };
    const sql: CompareFile = {
      filename: "apps/server/drizzle/20261115071050_turn_kind/migration.sql",
      status: "added",
      patch: "@@ -0,0 +1 @@\n+ALTER TABLE `turns` ADD `kind` text;",
      sha: blob("6"),
    };
    const design: CompareFile = {
      filename: "docs/DESIGN.md",
      status: "modified",
      patch: "@@ -100,2 +100,3 @@ ## Turns\n Turns run one at a time.\n+A turn has a kind.",
      sha: blob("7"),
    };
    // B: update-branch merged main in, which changed DESIGN.md above the PR's lines only.
    const designAtB = { ...design, patch: design.patch?.replace("-100,2 +100,3", "-112,2 +112,3") };
    const atA = racingGithub({ A: [snapshot, sql, design] }, "A");
    const atB = racingGithub({ B: [snapshot, sql, { ...designAtB, sha: blob("8") }] }, "B");
    const keyA = (await atA.port.prDetails("p-app", 440)).diffKey ?? null;
    const keyB = (await atB.port.prDetails("p-app", 440)).diffKey ?? null;
    expect(keyA).toMatch(/^[0-9a-f]{24}$/);
    expect(keyB).toBe(keyA);

    // The approval of A carries over to B: no re-check of "the new commits" is owed.
    const T = "2026-11-15T07:42:00.000Z";
    const seenA = { head_A: T, verdict_A: T, asked_A: T, [`diff_A:${keyA}`]: T };
    const approved = ReviewVerdict.parse(APPROVE);
    const next = settleApproval(
      seenA,
      { ...seenA, head_B: T },
      { headSha: "B", diffKey: keyB },
      approved,
      T,
    );
    expect(verdictHead({ nudges: next })).toBe("B");
    expect(recheckOf({ nudges: next })).toBeNull();

    // A new blob for the snapshot (its content changed) is the PR's own change: re-check it.
    const atC = racingGithub({ C: [{ ...snapshot, sha: blob("9") }, sql, design] }, "C");
    const keyC = (await atC.port.prDetails("p-app", 440)).diffKey ?? null;
    expect(keyC).not.toBe(keyA);
    const changed = settleApproval(
      seenA,
      { ...seenA, head_C: T },
      { headSha: "C", diffKey: keyC },
      approved,
      T,
    );
    expect(verdictHead({ nudges: changed })).toBe("A");
    expect(recheckOf({ nudges: changed })).toBe("A");
  });
});
