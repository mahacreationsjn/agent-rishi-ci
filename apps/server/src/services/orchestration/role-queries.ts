import type { RoleSessionsRef, Session } from "@agent-rishi/contracts";
import { and, desc, eq, inArray, isNull } from "drizzle-orm";
import type { Db } from "../../db/client";
import { rowToSession } from "../../db/rows";
import { sessions } from "../../db/schema";

/** Reads of the role sessions (§8.1) for `RoleSessions`. A retired one is archived. */

/** The current session of a role (the latest that isn't retired), if any. */
export function findRoleSession(
  db: Db,
  role: "orchestrator" | "pm",
  projectId: string | null,
): Session | undefined {
  if (role === "pm" && !projectId) return undefined;
  const row = db
    .select()
    .from(sessions)
    .where(
      and(
        eq(sessions.role, role),
        isNull(sessions.archivedAt),
        role === "orchestrator"
          ? isNull(sessions.projectId)
          : eq(sessions.projectId, projectId as string),
      ),
    )
    .orderBy(desc(sessions.createdAt))
    .limit(1)
    .get();
  return row ? rowToSession(row) : undefined;
}

/** Ids of every orchestrator and PM session, retired ones included. */
export function allRoleSessionIds(db: Db): Set<string> {
  const rows = db
    .select({ id: sessions.id })
    .from(sessions)
    .where(inArray(sessions.role, ["orchestrator", "pm"]))
    .all();
  return new Set(rows.map((r) => r.id));
}

/** The current role sessions: the orchestrator's and each project's PM. */
export function roleSessionRefs(db: Db): RoleSessionsRef {
  const rows = db
    .select()
    .from(sessions)
    .where(and(inArray(sessions.role, ["orchestrator", "pm"]), isNull(sessions.archivedAt)))
    .orderBy(sessions.createdAt)
    .all()
    .map(rowToSession);
  const ref: RoleSessionsRef = { orchestrator: null, pms: {} };
  for (const s of rows) {
    if (s.role === "orchestrator") ref.orchestrator = s.id;
    else if (s.projectId) ref.pms[s.projectId] = s.id;
  }
  return ref;
}
