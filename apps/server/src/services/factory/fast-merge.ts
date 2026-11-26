import type { FactoryLoop, Project } from "@agent-rishi/contracts";
import { type FactoryContext, raiseInbox } from "./context";
import type { FactoryPr, MainSince } from "./github-port";
import { matchesGlob } from "./globs";
import { changedPaths, isTestFile } from "./policy";
import { isLockfile } from "./size";

/**
 * The merge queue's fast path (§10.1, `MergePolicy` `fast`). A queued PR that is behind the
 * default branch merges on its own green CI, without being brought up to date first, whenever
 * GitHub can merge it: GitHub reports conflicts, and CI on the default branch is watched after
 * every merge (a merge that breaks it is reverted). It is re-tested first only when the PR and
 * the commits it is missing both changed files of a kind Git merges cleanly but that still
 * clash (`ClashGroup`: two dependency changes, two migrations), while CI on the default branch
 * is red, or when branch protection wants it up to date.
 */

/** Root files that change how every package installs. */
const ROOT_FILES = new Set([
  "pnpm-workspace.yaml",
  ".npmrc",
  ".nvmrc",
  ".node-version",
  ".tool-versions",
  "deno.json",
  "deno.jsonc",
  "go.work",
]);

/**
 * Dependency manifests, wherever they are: a workspace package's `package.json` installs and
 * runs scripts like the root one (their lockfiles are covered by `isLockfile`).
 */
const MANIFESTS = new Set([
  "package.json",
  "go.mod",
  "cargo.toml",
  "pyproject.toml",
  "pipfile",
  "gemfile",
  "composer.json",
  "pubspec.yaml",
  "mix.exs",
  "package.swift",
  "pom.xml",
  "build.gradle",
  "build.gradle.kts",
]);

/** Python requirement files: `requirements.txt`, `requirements-dev.txt`. */
const REQUIREMENTS = /^requirements(?:[-.][\w-]+)?\.txt$/i;

/** Globs for database migrations and schemas (`globs.ts` syntax). */
const MIGRATION_GLOBS = [
  "**/migrations/**",
  "**/migration/**",
  "**/drizzle/**",
  "*migration*",
  "*.prisma",
];

/**
 * Kinds of files where two changes that Git merges without a conflict can still break each
 * other, so a PR is tested on top of the other change before it merges:
 * - `dependencies`: lockfiles, dependency manifests and the files that say how packages install
 *   (two dependency changes can leave a lockfile that no longer installs);
 * - `migrations`: database migrations and schemas (two migrations made from the same state).
 */
export type ClashGroup = "dependencies" | "migrations";

const CLASH_LABEL: Record<ClashGroup, string> = {
  dependencies: "dependency files",
  migrations: "database migrations",
};

/** "dependency files", "database migrations": how a clash group reads in a note. */
export function clashLabel(group: ClashGroup): string {
  return CLASH_LABEL[group];
}

/** The clash group a file belongs to; null for every other file (tests of migrations included). */
export function clashGroup(path: string): ClashGroup | null {
  const normalized = path.replace(/\\/g, "/").replace(/^\.\//, "");
  const name = normalized.split("/").at(-1) ?? "";
  if (ROOT_FILES.has(normalized) || isLockfile(normalized)) return "dependencies";
  if (MANIFESTS.has(name.toLowerCase()) || REQUIREMENTS.test(name)) return "dependencies";
  if (isTestFile(normalized)) return null;
  return MIGRATION_GLOBS.some((g) => matchesGlob(normalized, g)) ? "migrations" : null;
}

/** The clash groups a list of changed files touches. */
export function clashGroups(paths: readonly string[]): Set<ClashGroup> {
  const groups = new Set<ClashGroup>();
  for (const path of paths) {
    const group = clashGroup(path);
    if (group) groups.add(group);
  }
  return groups;
}

/** The first clash group both sets have; null when they share none. */
export function sharedClashGroup(
  a: ReadonlySet<ClashGroup>,
  b: ReadonlySet<ClashGroup>,
): ClashGroup | null {
  for (const group of a) if (b.has(group)) return group;
  return null;
}

/** Whether the PR may merge on its own CI, or why it takes the strict path. */
export type FastVerdict =
  | { fast: true }
  | {
      fast: false;
      /** Why, in words that follow "re-testing against main: ". */
      reason: string;
      /** Branch protection requires up-to-date branches: the user hears once. */
      protection?: boolean;
    };

/** "a.ts", "a.ts (+2 more)". */
function some(paths: string[]): string {
  const [first] = paths;
  return paths.length > 1 ? `${first} (+${paths.length - 1} more)` : (first ?? "");
}

/**
 * The fast path's verdict for a queued PR that is behind the default branch (`main`: what
 * changed there since the PR's merge base). Every other check already passed on the PR's own
 * head, and GitHub reported no conflicts. `hold` is the loop's `fastMergeHold`.
 *
 * GitHub's merge state only sends it down the strict path when it names something a merge
 * can't get past (`behind`, `blocked`, `draft`, `dirty`). `unstable` and `unknown` lag behind
 * the checks the factory read itself, so the merge is tried and GitHub's answer decides.
 */
export function fastMergeVerdict(input: {
  branch: string;
  hold: string | null;
  pr: Pick<FactoryPr, "files" | "changedFiles" | "renamedFrom" | "mergeState">;
  main: MainSince;
}): FastVerdict {
  const { branch, hold, pr, main } = input;
  if (hold) return { fast: false, reason: `${hold}; fast merges resume once it is green` };
  const state = pr.mergeState ?? "unknown";
  if (state === "behind")
    return {
      fast: false,
      reason: `branch protection requires it to be up to date with ${branch}`,
      protection: true,
    };
  if (state === "blocked" || state === "draft" || state === "dirty")
    return { fast: false, reason: `GitHub reports its merge state as ${state}` };
  const mine = changedPaths(pr);
  if (!main.complete || (pr.changedFiles ?? 0) > pr.files.length)
    return { fast: false, reason: "too many changed files to compare" };
  const group = sharedClashGroup(clashGroups(mine), clashGroups(main.files));
  if (!group) return { fast: true };
  const here = mine.filter((f) => clashGroup(f) === group);
  const there = main.files.filter((f) => clashGroup(f) === group);
  return {
    fast: false,
    reason: `it and ${branch} both changed ${clashLabel(group)} (${some(here)}; on ${branch}: ${some(there)})`,
  };
}

/**
 * Hold or release fast merges by CI on the default branch's head: red holds them (the next PRs
 * take the strict path), green lets them go again. Pending or no CI changes nothing. Null when
 * GitHub couldn't be read: the queue tries again on the next tick.
 */
export async function withMainCi(
  ctx: FactoryContext,
  project: Project,
  loop: FactoryLoop,
  branch: string,
): Promise<FactoryLoop | null> {
  const main = await ctx.mainCi.head(ctx.github, project.id);
  if (!main) return null;
  if (main.checks === "success")
    return loop.fastMergeHold ? { ...loop, fastMergeHold: null } : loop;
  if (main.checks !== "failure" || loop.fastMergeHold) return loop;
  const failing = main.failed.join(", ") || "CI";
  return {
    ...loop,
    fastMergeHold: `CI on ${branch} is red (${failing} on ${main.sha.slice(0, 7)})`,
  };
}

/** Inbox id of "branch protection keeps the merge queue strict" (raised once per project). */
export const strictProtectionInboxId = (projectId: string) =>
  `inbox:factory-strict-merges:${projectId}`;

/**
 * Tell the user, once per project, that branch protection forces every PR through the strict
 * path. Never raised again, even after it is dismissed.
 */
export function noteProtectionForcesStrict(
  ctx: FactoryContext,
  project: Project,
  branch: string,
): void {
  const id = strictProtectionInboxId(project.id);
  if (ctx.inbox.find(id)) return;
  ctx.log?.(`factory: ${project.id}: branch protection requires up-to-date branches`);
  raiseInbox(ctx, {
    id,
    kind: "message",
    notify: "factory",
    priority: "low",
    projectId: project.id,
    title: "Branch protection keeps the merge queue on the strict path",
    body: `Branch protection on ${branch} requires pull requests to be up to date before they merge, so the factory brings each one up to date and waits for CI again before merging it, even when nothing it changes was touched on ${branch}. To let those merge on their own CI, turn off "Require branches to be up to date before merging" for ${branch} on GitHub. Nothing else is needed: merges carry on either way.`,
  });
}
