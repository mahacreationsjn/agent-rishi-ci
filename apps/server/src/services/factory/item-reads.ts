import type { FactoryItem } from "@agent-rishi/contracts";

/** A running read of one project's items. */
interface ProjectRead {
  /** Nested `during` calls still running. */
  depth: number;
  /** Every item of the project by id, once something asked for them. */
  items: Map<string, FactoryItem> | null;
  /** `items`, last updated first (sorted again after a write). */
  sorted: FactoryItem[] | null;
}

/**
 * One read of a project's work items, shared by the steps of a tick (`FactoryStore.readOnce`).
 * The first list asked for inside `during` loads every item of the project; later ones filter
 * that copy, and the store's writes (`remember`) keep it current. A tick reads the item list
 * from many of its steps; each read re-ran the query and re-parsed every row before.
 */
export class ItemReads {
  private readonly reads = new Map<string, ProjectRead>();

  /** `load`: every item of a project, as stored. */
  constructor(private readonly load: (projectId: string) => FactoryItem[]) {}

  /** Run `run` with the project's items read at most once. */
  async during<T>(projectId: string, run: () => Promise<T>): Promise<T> {
    const read = this.reads.get(projectId) ?? { depth: 0, items: null, sorted: null };
    read.depth += 1;
    this.reads.set(projectId, read);
    try {
      return await run();
    } finally {
      read.depth -= 1;
      if (read.depth === 0) this.reads.delete(projectId);
    }
  }

  /**
   * Inside `during`: the project's items, last updated first, loaded on first use (callers get
   * a list of their own to filter). Outside: undefined, the caller queries the database.
   */
  list(projectId: string): FactoryItem[] | undefined {
    const read = this.reads.get(projectId);
    if (!read) return undefined;
    read.items ??= new Map(this.load(projectId).map((i) => [i.id, i]));
    read.sorted ??= [...read.items.values()].sort((a, b) => byUpdate(b, a));
    return [...read.sorted];
  }

  /** The item, if a running read loaded it. */
  find(id: string): FactoryItem | undefined {
    for (const read of this.reads.values()) {
      const item = read.items?.get(id);
      if (item) return item;
    }
    return undefined;
  }

  /** Keep a running read current with an item the store just wrote. */
  remember(item: FactoryItem): void {
    const read = this.reads.get(item.projectId);
    if (!read?.items) return;
    read.items.set(item.id, item);
    read.sorted = null;
  }
}

/** Order by `updatedAt` as the `updated_at` column sorts (ISO stamps, compared as text). */
function byUpdate(a: FactoryItem, b: FactoryItem): number {
  return a.updatedAt < b.updatedAt ? -1 : a.updatedAt > b.updatedAt ? 1 : 0;
}
