import type { FactoryGithub, MainHead } from "./github-port";

/**
 * CI on a project's default branch as the loop sees it on one tick:
 * - `red`: `head` is red, or it is the last red head while CI still runs on a newer one (a
 *   merge that may fix it isn't known to until its CI passes);
 * - `running`: CI on the head hasn't finished (or reported), and no red head came before it;
 * - `green`: CI passed on the head.
 */
export type MainCiView =
  | { state: "red"; head: MainHead }
  | { state: "running" }
  | { state: "green" };

/**
 * Reads of CI on each project's default branch (§10.1), in memory. The head is read from GitHub
 * at most once per tick, shared by the verify step, the merge queue and intake (`runTick` calls
 * `beginTick`), and the last red head is kept until a green one replaces it.
 */
export class MainCiReads {
  private readonly reads = new Map<string, Promise<MainHead | null>>();
  private readonly red = new Map<string, MainHead>();

  /** A new tick reads the default branch from GitHub again. */
  beginTick(projectId: string): void {
    this.reads.delete(projectId);
  }

  /** The default branch's head and its CI, read once per tick; null when GitHub couldn't be read. */
  head(github: FactoryGithub, projectId: string): Promise<MainHead | null> {
    let read = this.reads.get(projectId);
    if (!read) {
      read = github.mainHead(projectId).then(
        (head) => {
          if (head.checks === "failure") this.red.set(projectId, head);
          else if (head.checks === "success") this.red.delete(projectId);
          return head;
        },
        () => null,
      );
      this.reads.set(projectId, read);
    }
    return read;
  }

  /** CI on the default branch on this tick; null when GitHub couldn't be read. */
  async view(github: FactoryGithub, projectId: string): Promise<MainCiView | null> {
    const head = await this.head(github, projectId);
    if (!head) return null;
    if (head.checks === "success") return { state: "green" };
    const red = this.red.get(projectId);
    return red ? { state: "red", head: red } : { state: "running" };
  }
}
