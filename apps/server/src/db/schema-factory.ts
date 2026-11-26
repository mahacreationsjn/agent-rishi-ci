import type {
  FactoryDigest,
  FactoryItem,
  FactoryLesson,
  FactoryLoop,
} from "@agent-rishi/contracts";
import { index, integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

/**
 * Factory loop projections (§10.1), written in the same transaction as their events
 * (`factory.loop.updated`, `factory.item.updated`, `factory.digest.created`,
 * `factory.lesson.updated`), so the loop can be rebuilt from the log and resumed after a restart.
 * Mode, limits and the project kill switch live on the project row.
 */

const json = <T>(name: string) => text(name, { mode: "json" }).$type<T>();

export const factoryLoops = sqliteTable("factory_loops", {
  projectId: text("project_id").primaryKey(),
  state: text("state").notNull(),
  loop: json<FactoryLoop>("loop").notNull(),
  updatedAt: text("updated_at").notNull(),
});

export const factoryItems = sqliteTable(
  "factory_items",
  {
    id: text("id").primaryKey(),
    projectId: text("project_id").notNull(),
    stage: text("stage").notNull(),
    workKey: text("work_key").notNull(),
    item: json<FactoryItem>("item").notNull(),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (t) => [
    index("factory_items_project_stage").on(t.projectId, t.stage),
    index("factory_items_updated").on(t.projectId, t.updatedAt),
  ],
);

export const factoryDigests = sqliteTable(
  "factory_digests",
  {
    id: text("id").primaryKey(),
    projectId: text("project_id").notNull(),
    day: text("day").notNull(),
    digest: json<FactoryDigest>("digest").notNull(),
    createdAt: text("created_at").notNull(),
  },
  (t) => [index("factory_digests_project").on(t.projectId, t.createdAt)],
);

/** The lessons the factory's reviewers recorded, one row per lesson (forgotten ones included). */
export const factoryLessons = sqliteTable(
  "factory_lessons",
  {
    id: text("id").primaryKey(),
    projectId: text("project_id").notNull(),
    /** `lessonKey` of the text: a lesson recorded again updates its row. */
    key: text("key").notNull(),
    lesson: json<FactoryLesson>("lesson").notNull(),
    lastSeenAt: text("last_seen_at").notNull(),
    /** Set once a person told the factory to forget it. */
    removedAt: text("removed_at"),
  },
  (t) => [
    index("factory_lessons_project_key").on(t.projectId, t.key),
    index("factory_lessons_project_seen").on(t.projectId, t.lastSeenAt),
  ],
);

/**
 * Providers new factory work skips after a factory session failed because of them (§10.1,
 * Provider availability), kept across restarts. Operational state like `github_sync_state`,
 * written directly rather than through events.
 */
export const providerBackoffs = sqliteTable("provider_backoffs", {
  provider: text("provider").primaryKey(),
  /** Why, as a phrase after the provider's name: "not signed in", "at its usage limit". */
  reason: text("reason").notNull(),
  /** A sign-in failure: skipped until the login changes, not for a fixed time. */
  signin: integer("signin", { mode: "boolean" }).notNull().default(false),
  /** Until when; for a sign-in failure, the safety re-try. */
  until: text("until").notNull(),
  /** For a sign-in failure: the login detection reported when it failed (null: not yet seen). */
  login: text("login"),
  failedAt: text("failed_at").notNull(),
});
