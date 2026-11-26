/**
 * Counts the root turns Codex starts on a session's thread, so a request that makes Codex start
 * one by itself (`thread/compact/start` answers `{}` and the turn follows as `turn/started`) can
 * wait for it. Read `count` before the request, then `startedSince(count, …)` after it: a turn
 * that started before the answer arrived counts too.
 */
export class TurnStartWatch {
  private started = 0;
  private readonly waiters = new Set<() => void>();

  /** Root turns started so far. */
  get count(): number {
    return this.started;
  }

  /** A root turn started. */
  note(): void {
    this.started += 1;
    for (const waiter of [...this.waiters]) waiter();
  }

  /** Whether a root turn started after `before` had, waiting up to `timeoutMs` for one. */
  startedSince(before: number, timeoutMs: number): Promise<boolean> {
    if (this.started > before) return Promise.resolve(true);
    return new Promise((resolve) => {
      const done = (started: boolean) => {
        clearTimeout(timer);
        this.waiters.delete(check);
        resolve(started);
      };
      const check = () => {
        if (this.started > before) done(true);
      };
      const timer = setTimeout(() => done(false), timeoutMs);
      this.waiters.add(check);
    });
  }
}
