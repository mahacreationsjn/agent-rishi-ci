import type {
  ChecksState,
  GitHubIssueRef,
  GitHubPrRef,
  GithubAuthorAssociation,
  GithubIssue,
} from "@agent-rishi/contracts";
import { ServiceError } from "../../src/services/errors";
import type {
  Commenter,
  CommitChecks,
  FactoryGithub,
  FactoryPr,
  IssueAuthor,
  MainSince,
  PrEvidence,
} from "../../src/services/factory/github-port";

/** Main's head before anything merged. */
const MAIN_START = "main0000000";

/** A pull request in the scripted GitHub. */
export interface FakePr extends FactoryPr {
  sessionId: string | null;
  /** Screenshots attached with `attach_evidence`. */
  evidence: boolean;
  /** Test output attached with `attach_evidence`. */
  testOutput: boolean;
  /** The default branch's head the PR's branch is based on (behind once main moves). */
  baseSha: string;
  /** Issues it closes ("Fixes #n"). */
  linkedIssues?: number[];
}

/**
 * A scripted GitHub for the factory loop: issues, PRs (linked to sessions), CI states, merges,
 * comments and reverts, all in memory. Tests change `prs`/`commitState` to steer the loop.
 */
export class FakeFactoryGithub implements FactoryGithub {
  issues: GithubIssue[] = [];
  prs = new Map<number, FakePr>();
  /**
   * Comments on issues and PRs (one numbering, as on GitHub). Without an `author` it is
   * Agent Rishi's own (the `viewer`); a test adds other people's with their login and association.
   */
  comments: Array<{
    number: number;
    body: string;
    author?: string;
    association?: GithubAuthorAssociation;
  }> = [];
  merges: Array<{ number: number; sha: string | null; title: string }> = [];
  reverts: Array<{ sha: string; prNumber: number }> = [];
  /** CI state per commit sha (default success). */
  commitState = new Map<string, CommitChecks>();
  /** Checks that failed per commit sha (default: `test` when its state is a failure). */
  commitFailures = new Map<string, string[]>();
  /**
   * Revert PR heads that are exactly the inverse of a merge (tree comparison), by head sha: the
   * merge sha. `revertMerge` adds its own (see `revertsExact`); an agent's revert isn't one.
   */
  exactReverts = new Map<string, string>();
  main = { sha: MAIN_START, checks: "success" as ChecksState, failed: [] as string[] };
  /**
   * Commits on main after `MAIN_START`, oldest first, with the files each changed: merges and
   * `pushMain`. Setting `main.sha` by hand leaves the history unknown (`mainSince` can't list
   * the files, so the merge queue takes the strict path).
   */
  mainCommits: Array<{ sha: string; files: string[] }> = [];
  /**
   * Branch protection requires PRs to be up to date: a PR behind main reports the merge state
   * `behind` (unless the test pins `pr.mergeState`) and GitHub refuses to merge it (405).
   */
  requireUpToDate = false;
  /**
   * How many reads of each other open PR report `mergeable: "unknown"` after a merge moved main:
   * GitHub works a PR out against the new base in the background (default 0: at once).
   */
  settleReads = 0;
  /** Reads left per PR number before it reports its mergeability again (`settleReads`). */
  private unsettled = new Map<number, number>();
  /**
   * How many more merges GitHub turns down with "Base branch was modified" (its answer to a
   * merge sent right after another one, before it caught up).
   */
  baseMovedRefusals = 0;
  /** `mainSince` calls, in order. */
  compares: number[] = [];
  githubProjects = new Set<string>();
  /** When false, `revertMerge` returns null (main moved on). */
  canRevertViaApi = true;
  /** CI on the revert PRs `revertMerge` opens. */
  revertChecks: ChecksState = "success";
  /** When false, the reverts `revertMerge` opens aren't exact (as if someone pushed to them). */
  revertsExact = true;
  /** The account Agent Rishi uses on GitHub (always trusted); null: unknown. */
  viewer: string | null = "agent-rishi";
  /** `update-branch` calls, in order. */
  updates: Array<{ number: number; expectedHeadSha: string }> = [];
  /** PRs closed through `closePr`, with their comment. */
  closed: Array<{ number: number; comment: string }> = [];
  /** `closePr` calls, refused ones included. */
  closeAttempts = 0;
  /** How many more `closePr` calls GitHub refuses (a transient error). */
  closeFailures = 0;
  /** CI state of the new head an `update-branch` makes (it starts running). */
  ciAfterUpdate: ChecksState = "pending";
  /** What `actionsAvailable` answers. */
  actions: boolean | null = true;
  /** Issue authors' relation to the repository by issue number (default `none`). */
  associations = new Map<number, GithubAuthorAssociation>();
  private next = 100;

  async viewerLogin(): Promise<string | null> {
    return this.viewer;
  }

  async issueAuthor(projectId: string, number: number): Promise<IssueAuthor> {
    return {
      login: this.issue(projectId, number)?.author ?? null,
      association: this.associations.get(number) ?? "none",
    };
  }

  /** When false, `commenters` fails (GitHub can't be read). */
  commentsReadable = true;
  /** `commenters` calls, in order. */
  commenterReads: number[] = [];

  async commenters(_projectId: string, number: number): Promise<Commenter[]> {
    this.commenterReads.push(number);
    if (!this.commentsReadable) throw new Error("GitHub is having a moment (502)");
    return this.comments
      .filter((c) => c.number === number)
      .map((c) => ({ login: c.author ?? this.viewer, association: c.association ?? "none" }));
  }

  /** An issue opened on GitHub by `author` (what the sync would project). */
  openIssue(opts: {
    projectId: string;
    title: string;
    author: string | null;
    body?: string;
    labels?: string[];
  }): GithubIssue {
    const number = this.next++;
    const now = new Date().toISOString();
    const issue: GithubIssue = {
      projectId: opts.projectId,
      number,
      title: opts.title,
      state: "open",
      url: `https://github.com/acme/app/issues/${number}`,
      labels: opts.labels ?? [],
      author: opts.author,
      body: opts.body ?? null,
      comments: 0,
      createdAt: now,
      updatedAt: now,
      closedAt: null,
      sessionIds: [],
    };
    this.issues.push(issue);
    return issue;
  }

  issue(_projectId: string, number: number): GithubIssue | null {
    return this.issues.find((i) => i.number === number) ?? null;
  }

  prRef(_projectId: string, number: number): GitHubPrRef | null {
    return this.prs.get(number)?.ref ?? null;
  }

  mergedPrClosing(_projectId: string, issueNumber: number): GitHubPrRef | null {
    const pr = [...this.prs.values()].find(
      (p) => p.ref.state === "merged" && (p.linkedIssues ?? []).includes(issueNumber),
    );
    return pr?.ref ?? null;
  }

  /** Close an issue on GitHub, as the sync would project it. */
  closeIssue(number: number, stateReason: GithubIssue["stateReason"] = "completed"): void {
    const issue = this.issues.find((i) => i.number === number);
    if (!issue) throw new Error(`no issue ${number}`);
    Object.assign(issue, { state: "closed", closedAt: new Date().toISOString(), stateReason });
  }

  isGithubProject(projectId: string): boolean {
    return this.githubProjects.has(projectId);
  }

  async createIssue(
    projectId: string,
    req: { title: string; body: string; labels: string[] },
  ): Promise<GitHubIssueRef> {
    const number = this.next++;
    const url = `https://github.com/acme/app/issues/${number}`;
    const now = new Date().toISOString();
    this.issues.push({
      projectId,
      number,
      title: req.title,
      state: "open",
      url,
      labels: req.labels,
      author: "agent-rishi",
      body: req.body,
      comments: 0,
      createdAt: now,
      updatedAt: now,
      closedAt: null,
      sessionIds: [],
    });
    return { number, url, title: req.title };
  }

  async labelIssue(_projectId: string, number: number, labels: string[]): Promise<void> {
    const issue = this.issues.find((i) => i.number === number);
    if (issue) issue.labels = [...new Set([...issue.labels, ...labels])];
  }

  async unlabelIssue(_projectId: string, number: number, labels: string[]): Promise<void> {
    const issue = this.issues.find((i) => i.number === number);
    if (issue) issue.labels = issue.labels.filter((l) => !labels.includes(l));
  }

  async comment(_projectId: string, number: number, body: string): Promise<void> {
    this.comments.push({ number, body });
  }

  openIssues(projectId: string): GithubIssue[] {
    return this.issues.filter((i) => i.projectId === projectId && i.state === "open");
  }

  /** Open a PR for a session (what `create_pull_request` would do). */
  openPr(opts: {
    sessionId: string | null;
    title: string;
    files: string[];
    /** Old paths of renamed or copied files (GitHub's `previous_filename`); `files` has the new ones. */
    renamedFrom?: string[];
    additions?: number;
    deletions?: number;
    /** Lines per file; the size check counts these (minus lockfiles) when given. */
    fileLines?: Array<{ path: string; lines: number }>;
    checks?: ChecksState;
    /** Default: mergeable. */
    mergeable?: FactoryPr["mergeable"];
    evidence?: boolean;
    testOutput?: boolean;
    /** Default: a description with a `## Test results` section. */
    body?: string;
  }): FakePr {
    const number = this.next++;
    const ref: GitHubPrRef = {
      number,
      url: `https://github.com/acme/app/pull/${number}`,
      state: "open",
      title: opts.title,
    };
    const pr: FakePr = {
      ref,
      title: opts.title,
      body: opts.body ?? "Fixes the issue\n\n## Test results\n- `pnpm test`: passed",
      headSha: `head${number}`,
      // What the PR itself changes: kept by update-branch and rebases, changed by a push.
      diffKey: `diff${number}`,
      headBranch: `agent-rishi/pr-${number}`,
      checks: opts.checks ?? "success",
      failedChecks: opts.checks === "failure" ? ["test"] : [],
      mergeable: opts.mergeable ?? "mergeable",
      additions: opts.additions ?? 20,
      deletions: opts.deletions ?? 2,
      files: opts.files,
      ...(opts.renamedFrom ? { renamedFrom: opts.renamedFrom } : {}),
      ...(opts.fileLines ? { fileLines: opts.fileLines } : {}),
      sessionId: opts.sessionId,
      evidence: opts.evidence ?? false,
      testOutput: opts.testOutput ?? false,
      baseSha: this.main.sha,
    };
    this.prs.set(number, pr);
    return pr;
  }

  /**
   * What a rebase by an agent does: a new head on the current main, without conflicts. The PR's
   * own change stays the same (its `diffKey`) unless the test changes it.
   */
  rebase(pr: FakePr, headSha: string, checks: ChecksState = "success"): void {
    Object.assign(pr, { headSha, baseSha: this.main.sha, mergeable: "mergeable", checks });
  }

  /** A push to the PR's branch that changes its code (`files` added): a new head and diff. */
  push(pr: FakePr, headSha: string, files: string[] = [], checks: ChecksState = "success"): void {
    Object.assign(pr, {
      headSha,
      diffKey: `${pr.diffKey ?? "diff"}+${headSha}`,
      files: [...new Set([...pr.files, ...files])],
      checks,
    });
  }

  async behindBy(_projectId: string, number: number): Promise<number> {
    const pr = this.prs.get(number);
    if (!pr) throw new Error(`no PR ${number}`);
    return pr.baseSha === this.main.sha ? 0 : 1;
  }

  /** Someone else's commit on main that changed `files`. */
  pushMain(files: string[], sha = `push${this.mainCommits.length + 1}`): string {
    this.mainCommits.push({ sha, files });
    this.main.sha = sha;
    return sha;
  }

  async mainSince(_projectId: string, number: number): Promise<MainSince> {
    const pr = this.prs.get(number);
    if (!pr) throw new Error(`no PR ${number}`);
    this.compares.push(number);
    if (pr.baseSha === this.main.sha) return { behind: 0, files: [], complete: true };
    const shas = [MAIN_START, ...this.mainCommits.map((c) => c.sha)];
    const from = shas.indexOf(pr.baseSha);
    const to = shas.indexOf(this.main.sha);
    if (from < 0 || to <= from) return { behind: 1, files: [], complete: false };
    const commits = this.mainCommits.slice(from, to);
    return {
      behind: commits.length,
      files: [...new Set(commits.flatMap((c) => c.files))],
      complete: true,
    };
  }

  async updateBranch(_projectId: string, number: number, expectedHeadSha: string): Promise<void> {
    const pr = this.prs.get(number);
    if (!pr) throw new Error(`no PR ${number}`);
    // Like GitHub (through `toGithubError`): a refusal is a 422.
    if (pr.headSha !== expectedHeadSha)
      throw new ServiceError(
        422,
        "github_validation",
        "expected head sha didn't match current head",
      );
    if (pr.mergeable === "conflicting")
      throw new ServiceError(422, "github_validation", "merge conflict between base and head");
    this.updates.push({ number, expectedHeadSha });
    Object.assign(pr, {
      headSha: `${pr.headSha}-up${this.updates.length}`,
      baseSha: this.main.sha,
      checks: this.ciAfterUpdate,
    });
  }

  async closePr(_projectId: string, number: number, comment: string): Promise<void> {
    const pr = this.prs.get(number);
    if (!pr) throw new Error(`no PR ${number}`);
    this.closeAttempts++;
    if (this.closeFailures > 0) {
      this.closeFailures--;
      throw new Error("GitHub is having a moment (502)");
    }
    this.comments.push({ number, body: comment });
    this.closed.push({ number, comment });
    pr.ref = { ...pr.ref, state: "closed" };
  }

  async actionsAvailable(): Promise<boolean | null> {
    return this.actions;
  }

  prForSession(_projectId: string, sessionId: string, branch: string | null): GitHubPrRef | null {
    return (
      [...this.prs.values()].find(
        (p) => p.sessionId === sessionId || (branch !== null && p.headBranch === branch),
      )?.ref ?? null
    );
  }

  async prDetails(_projectId: string, number: number): Promise<FactoryPr> {
    const pr = this.prs.get(number);
    if (!pr) throw new Error(`no PR ${number}`);
    const behind = pr.baseSha !== this.main.sha;
    const mergeState =
      pr.mergeState ??
      (pr.mergeable === "conflicting"
        ? "dirty"
        : this.requireUpToDate && behind
          ? "behind"
          : "clean");
    const waits = this.unsettled.get(number) ?? 0;
    if (waits > 0) this.unsettled.set(number, waits - 1);
    return {
      ...pr,
      ref: { ...pr.ref },
      files: [...pr.files],
      mergeState: waits > 0 ? "unknown" : mergeState,
      mergeable: waits > 0 ? "unknown" : pr.mergeable,
    };
  }

  async evidence(_projectId: string, prNumber: number): Promise<PrEvidence> {
    const pr = this.prs.get(prNumber);
    return { screenshots: pr?.evidence ?? false, testOutput: pr?.testOutput ?? false };
  }

  async merge(_projectId: string, number: number, opts: { sha: string | null; title: string }) {
    const pr = this.prs.get(number);
    if (!pr) throw new Error(`no PR ${number}`);
    // Like GitHub: a merge pinned to a head that moved is refused (a 409).
    if (opts.sha && opts.sha !== pr.headSha)
      throw new ServiceError(409, "github_conflict", "Head branch was modified");
    if (this.requireUpToDate && pr.baseSha !== this.main.sha)
      // Like GitHub through `toGithubError`: a 405 becomes `github_not_allowed`.
      throw new ServiceError(409, "github_not_allowed", "Head branch is out of date");
    if (this.baseMovedRefusals > 0) {
      this.baseMovedRefusals--;
      throw new ServiceError(
        409,
        "github_not_allowed",
        "GitHub: Base branch was modified. Review and try the merge again.",
      );
    }
    for (const other of this.prs.values())
      if (other !== pr && other.ref.state === "open")
        this.unsettled.set(other.ref.number, this.settleReads);
    pr.ref = { ...pr.ref, state: "merged" };
    const sha = `merge${number}`;
    this.merges.push({ number, sha, title: opts.title });
    this.mainCommits.push({ sha, files: [...pr.files] });
    this.main.sha = sha;
    return { merged: true, sha };
  }

  async commitChecks(_projectId: string, sha: string): Promise<CommitChecks> {
    return this.commitState.get(sha) ?? "success";
  }

  async failedChecks(_projectId: string, sha: string): Promise<string[]> {
    const failing = this.commitState.get(sha) === "failure";
    return this.commitFailures.get(sha) ?? (failing ? ["test"] : []);
  }

  async revertMatches(_projectId: string, revert: { headSha: string; mergeSha: string }) {
    return this.exactReverts.get(revert.headSha) === revert.mergeSha;
  }

  async mainHead() {
    return { ...this.main };
  }

  /**
   * Main's head at earlier times, oldest first, as a test records them (`at` is when that head
   * took over). `mainHeadAt` answers with the last one at or before the time asked about, and
   * with `main` when none is.
   */
  mainHistory: Array<{ at: string; sha: string; checks: CommitChecks; failed: string[] }> = [];

  async mainHeadAt(_projectId: string, at: string) {
    const then = this.mainHistory.filter((h) => Date.parse(h.at) <= Date.parse(at)).at(-1);
    return then
      ? { sha: then.sha, checks: then.checks, failed: [...then.failed] }
      : { ...this.main };
  }

  visionCommits: Array<{ path: string; contents: string }> = [];
  visionPr: GitHubPrRef | null = null;
  async shareVision(_projectId: string, path: string, contents: string) {
    const last = this.visionCommits.at(-1);
    if (last?.contents === contents) return this.visionPr;
    this.visionCommits.push({ path, contents });
    this.visionPr ??= {
      number: 900,
      url: "https://github.com/acme/widgets/pull/900",
      state: "open",
      title: "Update the project vision",
    };
    return this.visionPr;
  }

  /**
   * Like the real port: a revert PR with the merged PR's files and no evidence attached, whose
   * head is exactly the inverse of the merge (`exactReverts`). Its description has no
   * `## Test results` section, so the merge checks can't lean on one.
   */
  async revertMerge(_projectId: string, merge: { sha: string; prNumber: number; title: string }) {
    if (!this.canRevertViaApi) return null;
    this.reverts.push({ sha: merge.sha, prNumber: merge.prNumber });
    const pr = this.openPr({
      sessionId: null,
      title: `Revert "${merge.title}"`,
      files: this.prs.get(merge.prNumber)?.files ?? ["src/app.ts", "test/app.test.ts"],
      body: `Reverts #${merge.prNumber} (${merge.sha}).\n\nCI on \`main\` failed after the merge, so the Agent Rishi factory opened this revert and paused its loop.`,
      checks: this.revertChecks,
    });
    if (pr.headSha && this.revertsExact) this.exactReverts.set(pr.headSha, merge.sha);
    return pr.ref;
  }
}
