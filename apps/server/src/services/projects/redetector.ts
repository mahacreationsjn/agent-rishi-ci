import type { RawEventEnvelope, RefreshProjectResponse } from "@agent-rishi/contracts";
import type { EventStore } from "../../events/store";
import { errorMessage } from "../errors";
import type { SessionRepo } from "../sessions/repo";
import type { ProjectService } from "./project-service";

export interface ProjectRedetectorDeps {
  projects: ProjectService;
  store: EventStore;
  repo: SessionRepo;
  /** A project became a GitHub project or moved to another repository: sync it now. */
  onGithubChanged?: (projectId: string) => void;
  log?: (message: string) => void;
}

const TURN_ENDS = new Set(["agent.turn.completed", "agent.turn.failed", "agent.turn.interrupted"]);

/**
 * Keeps each project's kind in step with its folder (§9). A project's git checkout and GitHub
 * remote are detected again on demand (the UI's "Check again"), once for every project when
 * the server starts, and whenever an agent turn ends in a local-only project: the moment an
 * agent may have run `git init` or added a GitHub `origin`. One check per project at a time;
 * a turn that ends during a check queues one more. A session start doesn't wait for the
 * background check to reach its project: it checks that project first (`current`). Plain
 * folders don't wait at all: start settles them without git before the server serves anything.
 */
export class ProjectRedetector {
  private unsubscribe: (() => void) | undefined;
  private stopped = true;
  private readonly running = new Map<string, Promise<RefreshProjectResponse>>();
  private readonly again = new Set<string>();
  /**
   * Projects stored before this start that no check has reached yet: what their records say
   * about the folder may be out of date (an upgrade adds `isGitRepo` as true for all of them).
   * Never a plain folder: start settles those at once.
   */
  private readonly unchecked = new Set<string>();

  constructor(private readonly deps: ProjectRedetectorDeps) {}

  /**
   * Follow turn ends and, unless `checkAll: false`, check every project: a plain folder at once
   * (no git needed, `ProjectService.refreshPlainFolder`), before the server serves anything, so
   * the UI never offers it a worktree (#454); the others in the background.
   */
  start(opts: { checkAll?: boolean } = {}): void {
    this.stopped = false;
    this.unsubscribe ??= this.deps.store.subscribe((events) => this.onEvents(events));
    if (opts.checkAll === false) return;
    try {
      for (const project of this.deps.projects.list()) {
        if (!this.checkPlainFolder(project.id)) this.unchecked.add(project.id);
      }
    } catch (error) {
      this.deps.log?.(`projects: listing for the start-up check: ${errorMessage(error)}`);
      return;
    }
    setImmediate(() => void this.checkAll());
  }

  /** True when the project's folder is a plain one and its record now says so. Never throws. */
  private checkPlainFolder(projectId: string): boolean {
    try {
      const result = this.deps.projects.refreshPlainFolder(projectId);
      if (result?.changed) this.deps.log?.(`projects: ${result.project.name}: ${result.message}`);
      return result !== null;
    } catch (error) {
      this.deps.log?.(`projects: checking ${projectId}: ${errorMessage(error)}`);
      return false;
    }
  }

  /**
   * Stop following turn ends and start no more checks. Resolves once the checks already running
   * have finished: their `git -C <project>` would otherwise outlive the server, still inside the
   * project folder (which Windows then refuses to delete) and writing to a closed database.
   */
  async stop(): Promise<void> {
    this.stopped = true;
    this.unsubscribe?.();
    this.unsubscribe = undefined;
    await Promise.allSettled([...this.running.values()]);
  }

  /** Detect one project again now (joins a check already running for it). */
  refresh(projectId: string): Promise<RefreshProjectResponse> {
    const inFlight = this.running.get(projectId);
    if (inFlight) return inFlight;
    const run = this.deps.projects
      .refresh(projectId)
      .then((result) => {
        const github = result.outcome === "github_connected" || result.outcome === "github_changed";
        if (result.changed) {
          this.deps.log?.(`projects: ${result.project.name}: ${result.message}`);
          if (github) this.deps.onGithubChanged?.(projectId);
        }
        return result;
      })
      .finally(() => {
        this.running.delete(projectId);
        // Checked, even when the check failed: the record stays as it was.
        this.unchecked.delete(projectId);
        if (this.again.delete(projectId)) this.afterTurn(projectId);
      });
    this.running.set(projectId, run);
    return run;
  }

  /**
   * Resolves once the project's record is current for this start (#425): at once when a check
   * has reached it since the server started (or it was added since, or there was no start-up
   * check), else after checking it now, joining a check already running. A session start waits
   * for it before it picks its workspace from `isGitRepo`. Never throws.
   */
  async current(projectId: string): Promise<void> {
    if (this.stopped || !this.unchecked.has(projectId)) return;
    await this.refresh(projectId).catch((error: unknown) =>
      this.deps.log?.(`projects: checking ${projectId}: ${errorMessage(error)}`),
    );
  }

  /** Check every project listed at start, one at a time (on server start). Never throws. */
  async checkAll(): Promise<void> {
    for (const projectId of [...this.unchecked]) {
      if (this.stopped) return; // closed (the database may be closed)
      if (!this.unchecked.has(projectId)) continue; // a session start or a turn end checked it
      await this.refresh(projectId).catch((error: unknown) =>
        this.deps.log?.(`projects: checking ${projectId}: ${errorMessage(error)}`),
      );
    }
  }

  private onEvents(events: RawEventEnvelope[]): void {
    const sessionIds = new Set<string>();
    for (const e of events) if (TURN_ENDS.has(e.type) && e.sessionId) sessionIds.add(e.sessionId);
    if (sessionIds.size === 0) return;
    // After commit, never inside the store's notification.
    setImmediate(() => {
      if (this.stopped) return;
      const projectIds = new Set<string>();
      try {
        for (const id of sessionIds) {
          const projectId = this.deps.repo.find(id)?.session.projectId;
          if (projectId) projectIds.add(projectId);
        }
      } catch (error) {
        this.deps.log?.(`projects: after a turn: ${errorMessage(error)}`);
        return;
      }
      for (const projectId of projectIds) this.afterTurn(projectId);
    });
  }

  /** A turn ended in this project: check it if it is still local-only. */
  private afterTurn(projectId: string): void {
    if (this.stopped) return;
    try {
      const project = this.deps.projects.get(projectId);
      if (project.kind !== "local" || project.archivedAt !== null) return;
    } catch {
      return; // the project is gone, or the database is closing
    }
    if (this.running.has(projectId)) {
      this.again.add(projectId);
      return;
    }
    this.refresh(projectId).catch((error: unknown) =>
      this.deps.log?.(`projects: checking ${projectId}: ${errorMessage(error)}`),
    );
  }
}
