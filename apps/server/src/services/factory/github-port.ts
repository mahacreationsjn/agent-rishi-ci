import {
  type ChecksState,
  type GitHubIssueRef,
  type GitHubPrRef,
  type GithubAuthorAssociation,
  type GithubIssue,
  githubPrId,
  type Mergeable,
  type PrMergeState,
} from "@agent-rishi/contracts";
import { errorMessage } from "../errors";
import { EVIDENCE_HEADING } from "../github/evidence";
import type { GithubService } from "../github/github-service";
import { authorAssociation } from "../github/graphql";
import * as commentOps from "./github-port-comments";
import * as prOps from "./github-port-prs";
import * as revertOps from "./github-port-revert";

/** A pull request as the merge checks read it. */
export interface FactoryPr {
  ref: GitHubPrRef;
  title: string;
  body: string;
  headSha: string | null;
  headBranch: string;
  /** Combined state of CI on the head commit. */
  checks: ChecksState;
  failedChecks: string[];
  /**
   * Whether it merges cleanly into its base. GitHub runs no `pull_request` workflows while it
   * is `conflicting`, so no CI reports until the author resolves the conflicts.
   */
  mergeable: Mergeable;
  /**
   * GitHub's detailed merge state (`PrMergeState`): `behind` means branch protection requires
   * the PR to be up to date before it merges. Absent: unknown.
   */
  mergeState?: PrMergeState;
  additions: number;
  deletions: number;
  files: string[];
  /**
   * How many files GitHub counts as changed; more than `files.length` past its 3000-file list.
   * Absent: `files` is the whole list.
   */
  changedFiles?: number;
  /** The paths renamed files had before the PR (they count as changed for the merge queue). */
  renamedFrom?: string[];
  /**
   * Added + deleted lines per file, when GitHub reports them; `previousPath` is a renamed or
   * copied file's old path.
   */
  fileLines?: Array<{ path: string; previousPath?: string; lines: number }>;
  /**
   * Fingerprint of what the PR at `headSha` itself changes (`prDiffKey`, read pinned to that
   * commit): the same on a head that only brought the default branch in, so the approval
   * carries over (`approval.ts`). Null when it can't be told; absent when not read.
   */
  diffKey?: string | null;
}

/** What the default branch has that a PR's head doesn't (`FactoryGithub.mainSince`). */
export interface MainSince {
  /** Commits on the default branch since the PR's merge base (0: up to date). */
  behind: number;
  /** Files those commits changed (old paths of renames included). */
  files: string[];
  /** False when GitHub's list stops short (it lists at most 300 files), so `files` may miss some. */
  complete: boolean;
}

/** Commit-level CI state, for watching main after a merge. */
export type CommitChecks = ChecksState;

/** A commit on the default branch and its CI. */
export interface MainHead {
  sha: string;
  checks: CommitChecks;
  /** Names of the checks that failed on it. */
  failed: string[];
}

/** Evidence attached to a PR (or its issue) through `attach_evidence`. */
export interface PrEvidence {
  /** Screenshots or other images. */
  screenshots: boolean;
  /** Raw test output (`attach_evidence` with `testOutput`). */
  testOutput: boolean;
}

/** Who opened an issue, fresh from GitHub. */
export interface IssueAuthor {
  login: string | null;
  /** Their relation to the repository (`owner`, `member` and `collaborator` have write access). */
  association: GithubAuthorAssociation;
}

/** Who wrote a comment or a review on an issue or pull request, fresh from GitHub. */
export type Commenter = IssueAuthor;

/**
 * What the factory needs from GitHub (§9), as a port so tests can run the loop against a
 * scripted GitHub. `GithubFactoryPort` implements it over `GithubService`.
 */
export interface FactoryGithub {
  isGithubProject(projectId: string): boolean;
  /** The login of the account Agent Rishi uses on GitHub (always trusted); null when unknown. */
  viewerLogin(): Promise<string | null>;
  /** An issue's author and their association with the repository (one API call). */
  issueAuthor(projectId: string, number: number): Promise<IssueAuthor>;
  /**
   * Everyone who commented on an issue or pull request, one entry per comment: its conversation
   * and, with `pr`, the pull request's reviews and review comments.
   */
  commenters(projectId: string, number: number, opts: { pr: boolean }): Promise<Commenter[]>;
  createIssue(
    projectId: string,
    req: { title: string; body: string; labels: string[] },
  ): Promise<GitHubIssueRef>;
  labelIssue(projectId: string, number: number, labels: string[]): Promise<void>;
  /** Remove labels from an issue (one it doesn't have is no error); the projection follows. */
  unlabelIssue(projectId: string, number: number, labels: string[]): Promise<void>;
  comment(projectId: string, number: number, body: string): Promise<void>;
  /** Open issues (projection), for intake. */
  openIssues(projectId: string): GithubIssue[];
  /** One issue from the projection (open or closed); null when it was never synced. */
  issue(projectId: string, number: number): GithubIssue | null;
  /** A PR as last synced (projection, no API call); null when unknown. */
  prRef(projectId: string, number: number): GitHubPrRef | null;
  /**
   * A merged PR that closes the issue (it links it with "Fixes #n"), from the projection; null
   * when none is known.
   */
  mergedPrClosing(projectId: string, issueNumber: number): GitHubPrRef | null;
  /** The PR a session opened (or whose head is its branch), if known. */
  prForSession(projectId: string, sessionId: string, branch: string | null): GitHubPrRef | null;
  prDetails(projectId: string, number: number): Promise<FactoryPr>;
  /** Screenshots and test output attached to the PR (or its issue) with `attach_evidence`. */
  evidence(projectId: string, prNumber: number, issueNumber: number | null): Promise<PrEvidence>;
  merge(
    projectId: string,
    number: number,
    opts: { sha: string | null; title: string },
  ): Promise<{ merged: boolean; sha: string | null }>;
  commitChecks(projectId: string, sha: string): Promise<CommitChecks>;
  /** Names of the checks that failed on a commit (CI on the default branch after a merge). */
  failedChecks(projectId: string, sha: string): Promise<string[]>;
  /** Head of the default branch and its CI state. */
  mainHead(projectId: string): Promise<MainHead>;
  /**
   * The default branch's head as it was at `at` (its newest commit then) and that commit's CI
   * now; null when the branch had no commit by then.
   */
  mainHeadAt(projectId: string, at: string): Promise<MainHead | null>;
  /** Commits the default branch has that the PR's head (`headSha`) doesn't; 0 when up to date. */
  behindBy(projectId: string, number: number, headSha: string): Promise<number>;
  /**
   * The commits the default branch has that the PR's head doesn't, and the files they changed
   * (one compare from the merge base), for the merge queue's fast path.
   */
  mainSince(projectId: string, number: number, headSha: string): Promise<MainSince>;
  /**
   * Bring a PR up to date with the default branch on GitHub (`update-branch`, no agent). Throws
   * when the head is no longer `expectedHeadSha` or the merge would conflict.
   */
  updateBranch(projectId: string, number: number, expectedHeadSha: string): Promise<void>;
  /** Comment on a pull request, then close it (a rebuild replaced it). */
  closePr(projectId: string, number: number, comment: string): Promise<void>;
  /**
   * Whether CI can run on the repository: Actions enabled with an active workflow. Null when
   * GitHub doesn't say.
   */
  actionsAvailable(projectId: string): Promise<boolean | null>;
  /**
   * Open a PR reverting a squash merge when it is still the head of the default branch;
   * null when main moved on (the loop then asks an agent to write the revert).
   */
  revertMerge(
    projectId: string,
    merge: { sha: string; prNumber: number; title: string },
  ): Promise<GitHubPrRef | null>;
  /**
   * Whether a revert PR's head is exactly the inverse of the squash merge it reverts, by tree
   * comparison: its only parent is the merge and its tree is the merge's parent's. False for a
   * revert that had conflicts to resolve or changes anything else (it gets the normal review).
   */
  revertMatches(projectId: string, revert: { headSha: string; mergeSha: string }): Promise<boolean>;
  /**
   * Commit the vision file to the `agent-rishi/vision` branch (from the default branch, or on top
   * of its open PR) and open or update that PR. Null when the file already matches.
   */
  shareVision(projectId: string, path: string, contents: string): Promise<GitHubPrRef | null>;
}

/** Branch the vision editor commits to. */
export const VISION_BRANCH = "agent-rishi/vision";

const IMAGE_LINK = /\.(png|jpe?g|gif|webp)\?raw=true/i;
const TEST_OUTPUT = /<summary>Test output<\/summary>/i;
const LOGIN_TTL_MS = 10 * 60_000;

/** `FactoryGithub` over the real `GithubService` (Octokit, the PR/issue projections). */
export class GithubFactoryPort implements FactoryGithub {
  private login: { value: string | null; at: number } | null = null;
  /** `diffKeyAt`'s fingerprints per head commit. */
  private readonly diffKeys = new Map<string, string | null>();

  constructor(private readonly github: GithubService) {}

  async viewerLogin(): Promise<string | null> {
    if (this.login && Date.now() - this.login.at < LOGIN_TTL_MS) return this.login.value;
    const value = await this.github
      .connection()
      .then((c) => c.login)
      .catch(() => null);
    // Remember a failure only briefly, so trust comes back as soon as GitHub does.
    this.login = { value, at: value ? Date.now() : Date.now() - LOGIN_TTL_MS + 30_000 };
    return value;
  }

  async issueAuthor(projectId: string, number: number): Promise<IssueAuthor> {
    const repo = this.github.githubRepo(projectId);
    const data = await this.github.client.run(
      async (o) =>
        (await o.rest.issues.get({ owner: repo.owner, repo: repo.repo, issue_number: number }))
          .data,
    );
    return {
      login: data.user?.login ?? null,
      association: authorAssociation(data.author_association),
    };
  }

  commenters(projectId: string, number: number, opts: { pr: boolean }): Promise<Commenter[]> {
    return commentOps.commenters(this.github, projectId, number, opts.pr);
  }

  isGithubProject(projectId: string): boolean {
    try {
      this.github.githubRepo(projectId);
      return true;
    } catch {
      return false;
    }
  }

  async createIssue(projectId: string, req: { title: string; body: string; labels: string[] }) {
    const issue = await this.github.createIssue(projectId, req);
    return { number: issue.number, url: issue.url, title: issue.title };
  }

  async labelIssue(projectId: string, number: number, labels: string[]): Promise<void> {
    await this.github.labelIssue(projectId, number, { add: labels, remove: [] });
  }

  async unlabelIssue(projectId: string, number: number, labels: string[]): Promise<void> {
    await this.github.labelIssue(projectId, number, { add: [], remove: labels });
  }

  async comment(projectId: string, number: number, body: string): Promise<void> {
    await this.github.commentOnIssue(projectId, number, body);
  }

  openIssues(projectId: string): GithubIssue[] {
    return this.github.data.issues(projectId, "open", 200);
  }

  issue(projectId: string, number: number): GithubIssue | null {
    return this.github.data.issue(projectId, number) ?? null;
  }

  prRef(projectId: string, number: number): GitHubPrRef | null {
    const pr = this.github.data.pr(projectId, number);
    return pr ? { number: pr.number, url: pr.url, state: pr.state, title: pr.title } : null;
  }

  mergedPrClosing(projectId: string, issueNumber: number): GitHubPrRef | null {
    const pr = this.github.data
      .prs(projectId, "closed", 200)
      .find((p) => p.state === "merged" && p.linkedIssues.includes(issueNumber));
    return pr ? { number: pr.number, url: pr.url, state: pr.state, title: pr.title } : null;
  }

  prForSession(projectId: string, sessionId: string, branch: string | null): GitHubPrRef | null {
    const pr = this.github.data
      .prs(projectId, "all", 200)
      .find((p) => p.sessionId === sessionId || (branch !== null && p.headBranch === branch));
    return pr ? { number: pr.number, url: pr.url, state: pr.state, title: pr.title } : null;
  }

  async prDetails(projectId: string, number: number): Promise<FactoryPr> {
    const pr = await this.github.getPrDetails(githubPrId(projectId, number));
    // Read pinned to this read's head commit, so it is that head's (`diffKeyAt`).
    const diffKey = pr.headSha
      ? await prOps.diffKeyAt(this.github, projectId, pr.baseBranch, pr.headSha, this.diffKeys)
      : null;
    return {
      diffKey,
      ref: { number: pr.number, url: pr.url, state: pr.state, title: pr.title },
      title: pr.title,
      body: pr.body,
      headSha: pr.headSha,
      headBranch: pr.headBranch,
      checks: pr.checks.state,
      failedChecks: pr.checks.checks
        .filter((c) => c.conclusion && !["success", "neutral", "skipped"].includes(c.conclusion))
        .map((c) => c.name),
      mergeable: pr.mergeable,
      mergeState: pr.mergeState ?? "unknown",
      additions: pr.additions,
      deletions: pr.deletions,
      files: pr.files.map((f) => f.path),
      changedFiles: pr.changedFiles,
      renamedFrom: pr.files.flatMap((f) => (f.previousPath ? [f.previousPath] : [])),
      fileLines: pr.files.map((f) => ({
        path: f.path,
        ...(f.previousPath ? { previousPath: f.previousPath } : {}),
        lines: f.additions + f.deletions,
      })),
    };
  }

  async evidence(
    projectId: string,
    prNumber: number,
    issueNumber: number | null,
  ): Promise<PrEvidence> {
    const repo = this.github.githubRepo(projectId);
    const found: PrEvidence = { screenshots: false, testOutput: false };
    const viewer = (await this.viewerLogin())?.toLowerCase() ?? null;
    for (const number of [prNumber, ...(issueNumber ? [issueNumber] : [])]) {
      const comments = await this.github.client.run(async (o) =>
        o.paginate(o.rest.issues.listComments, {
          owner: repo.owner,
          repo: repo.repo,
          issue_number: number,
          per_page: 100,
        }),
      );
      // Only Agent Rishi's own evidence comments count (anyone can comment on a public repo).
      for (const c of comments) {
        const body = c.body ?? "";
        if (!body.startsWith(EVIDENCE_HEADING)) continue;
        if (viewer && c.user?.login?.toLowerCase() !== viewer) continue;
        if (IMAGE_LINK.test(body)) found.screenshots = true;
        if (TEST_OUTPUT.test(body)) found.testOutput = true;
      }
      if (found.screenshots && found.testOutput) break;
    }
    return found;
  }

  async merge(projectId: string, number: number, opts: { sha: string | null; title: string }) {
    return this.github.mergePr(githubPrId(projectId, number), {
      method: "squash",
      ...(opts.sha ? { sha: opts.sha } : {}),
      commitTitle: opts.title,
    });
  }

  async commitChecks(projectId: string, sha: string): Promise<CommitChecks> {
    return (await this.checksFor(projectId, sha)).state;
  }

  async failedChecks(projectId: string, sha: string): Promise<string[]> {
    return (await this.checksFor(projectId, sha)).failed;
  }

  async mainHead(projectId: string) {
    const repo = this.github.githubRepo(projectId);
    const branch = await this.github.client.run(
      async (o) =>
        (
          await o.rest.repos.getBranch({
            owner: repo.owner,
            repo: repo.repo,
            branch: repo.defaultBranch,
          })
        ).data,
    );
    const { state, failed } = await this.checksFor(projectId, branch.commit.sha);
    return { sha: branch.commit.sha, checks: state, failed };
  }

  async mainHeadAt(projectId: string, at: string): Promise<MainHead | null> {
    const sha = await prOps.mainShaAt(this.github, projectId, at);
    if (!sha) return null;
    const { state, failed } = await this.checksFor(projectId, sha);
    return { sha, checks: state, failed };
  }

  behindBy(projectId: string, _number: number, headSha: string): Promise<number> {
    return prOps.behindBy(this.github, projectId, headSha);
  }

  mainSince(projectId: string, _number: number, headSha: string): Promise<MainSince> {
    return prOps.mainSince(this.github, projectId, headSha);
  }

  updateBranch(projectId: string, number: number, expectedHeadSha: string): Promise<void> {
    return prOps.updateBranch(this.github, projectId, number, expectedHeadSha);
  }

  closePr(projectId: string, number: number, comment: string): Promise<void> {
    return prOps.closePr(this.github, projectId, number, comment);
  }

  actionsAvailable(projectId: string): Promise<boolean | null> {
    return prOps.actionsAvailable(this.github, projectId);
  }

  async shareVision(projectId: string, path: string, contents: string) {
    const { owner, repo: name, defaultBranch } = this.github.githubRepo(projectId);
    const ref = (pr: { number: number; html_url: string; title: string }): GitHubPrRef => ({
      number: pr.number,
      url: pr.html_url,
      state: "open",
      title: pr.title,
    });
    const result = await this.github.client.run(async (o) => {
      const open = (
        await o.rest.pulls.list({
          owner,
          repo: name,
          head: `${owner}:${VISION_BRANCH}`,
          state: "open",
          per_page: 1,
        })
      ).data[0];
      const parentRef = open ? `heads/${VISION_BRANCH}` : `heads/${defaultBranch}`;
      const parent = (await o.rest.git.getRef({ owner, repo: name, ref: parentRef })).data.object
        .sha;
      const parentTree = (await o.rest.git.getCommit({ owner, repo: name, commit_sha: parent }))
        .data.tree.sha;
      const tree = await o.rest.git.createTree({
        owner,
        repo: name,
        base_tree: parentTree,
        tree: [{ path, mode: "100644", type: "blob", content: contents }],
      });
      if (tree.data.sha === parentTree) return open ? ref(open) : null;
      const commit = await o.rest.git.createCommit({
        owner,
        repo: name,
        message: "docs: update the project vision\n\nSaved from the Agent Rishi vision editor.",
        tree: tree.data.sha,
        parents: [parent],
      });
      if (open) {
        await o.rest.git.updateRef({
          owner,
          repo: name,
          ref: `heads/${VISION_BRANCH}`,
          sha: commit.data.sha,
        });
        return ref(open);
      }
      // A stale branch from a merged or closed vision PR is reset onto the new commit.
      await o.rest.git
        .createRef({ owner, repo: name, ref: `refs/heads/${VISION_BRANCH}`, sha: commit.data.sha })
        .catch(() =>
          o.rest.git.updateRef({
            owner,
            repo: name,
            ref: `heads/${VISION_BRANCH}`,
            sha: commit.data.sha,
            force: true,
          }),
        );
      const pr = await o.rest.pulls.create({
        owner,
        repo: name,
        head: VISION_BRANCH,
        base: defaultBranch,
        title: "Update the project vision",
        body: `Commits \`${path}\`, saved from the Agent Rishi vision editor. The factory reads the vision from the local checkout right away; merging this shares it with agent worktrees, which start from \`${defaultBranch}\`.`,
      });
      return ref(pr.data);
    });
    this.github.sync.soon(projectId);
    return result;
  }

  revertMerge(projectId: string, merge: { sha: string; prNumber: number; title: string }) {
    return revertOps.revertMerge(this.github, projectId, merge);
  }

  revertMatches(projectId: string, revert: { headSha: string; mergeSha: string }) {
    return revertOps.revertMatches(this.github, projectId, revert);
  }

  private async checksFor(
    projectId: string,
    sha: string,
  ): Promise<{ state: CommitChecks; failed: string[] }> {
    const repo = this.github.githubRepo(projectId);
    try {
      return await this.github.client.run(async (o) => {
        const [combined, runs] = await Promise.all([
          o.rest.repos.getCombinedStatusForRef({ owner: repo.owner, repo: repo.repo, ref: sha }),
          o.rest.checks.listForRef({ owner: repo.owner, repo: repo.repo, ref: sha, per_page: 100 }),
        ]);
        const states: Array<{ name: string; state: "success" | "failure" | "pending" }> = [
          ...combined.data.statuses.map((s) => ({
            name: s.context,
            state:
              s.state === "success"
                ? ("success" as const)
                : s.state === "pending"
                  ? ("pending" as const)
                  : ("failure" as const),
          })),
          ...runs.data.check_runs.map((r) => ({
            name: r.name,
            state:
              r.status !== "completed"
                ? ("pending" as const)
                : ["success", "neutral", "skipped"].includes(r.conclusion ?? "")
                  ? ("success" as const)
                  : ("failure" as const),
          })),
        ];
        const failed = states.filter((s) => s.state === "failure").map((s) => s.name);
        if (states.length === 0) return { state: "none" as const, failed };
        if (failed.length > 0) return { state: "failure" as const, failed };
        if (states.some((s) => s.state === "pending")) return { state: "pending" as const, failed };
        return { state: "success" as const, failed };
      });
    } catch (error) {
      throw new Error(`checks for ${sha.slice(0, 7)}: ${errorMessage(error)}`);
    }
  }
}
