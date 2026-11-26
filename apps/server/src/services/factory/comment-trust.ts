import type { FactoryItem } from "@agent-rishi/contracts";
import { errorMessage } from "../errors";
import type { FactoryContext } from "./context";
import type { Commenter } from "./github-port";
import { hasWriteAccess, isTrustedAuthor, trustedLogins } from "./trust";

/**
 * Who commented on factory work without the project's trust (§10.1). An item is trusted for who
 * opened its issue, but on a public repository anyone can comment on that issue or on the
 * factory's pull request, and builders and reviewers read those comments with `gh`. Their briefs
 * name such commenters as untrusted input, and a lesson is kept only from work none of them
 * commented on (`lessons.ts`), because a lesson reaches every later brief in the project.
 *
 * A commenter is trusted like the author of a pull request review (`review-trust.ts`): write
 * access to the repository, the account Agent Rishi uses on GitHub, or one of the project's trusted
 * authors.
 */

/** Someone the project doesn't trust who commented on an item's issue or pull request. */
export interface UntrustedCommenter {
  /** Their login with "@"; "@ghost" for a deleted account, as GitHub shows it. */
  login: string;
  /** The issue and pull request numbers they commented on. */
  on: number[];
}

/** Whether a commenter is trusted: write access, or one of `trusted` (lower-cased logins). */
export function isTrustedCommenter(c: Commenter, trusted: ReadonlySet<string>): boolean {
  return hasWriteAccess(c.association) || isTrustedAuthor(c.login, trusted);
}

/**
 * Who commented on the item's issue and pull request without the project's trust, read from
 * GitHub now; empty for work with neither, or outside a GitHub project. Null when GitHub
 * couldn't be read, so a caller that needs a trusted source knows it has none.
 */
export async function untrustedCommenters(
  ctx: FactoryContext,
  item: Pick<FactoryItem, "id" | "projectId" | "issue" | "pr">,
): Promise<UntrustedCommenter[] | null> {
  const targets = [
    ...(item.issue ? [{ number: item.issue.number, pr: false }] : []),
    ...(item.pr ? [{ number: item.pr.number, pr: true }] : []),
  ];
  if (targets.length === 0 || !ctx.github.isGithubProject(item.projectId)) return [];
  try {
    const limits = ctx.projects.get(item.projectId).factoryLimits;
    const trusted = trustedLogins(limits, await ctx.github.viewerLogin());
    const found = new Map<string, Set<number>>();
    for (const { number, pr } of targets) {
      for (const c of await ctx.github.commenters(item.projectId, number, { pr })) {
        if (isTrustedCommenter(c, trusted)) continue;
        const login = `@${c.login ?? "ghost"}`;
        found.set(login, (found.get(login) ?? new Set()).add(number));
      }
    }
    return [...found].map(([login, on]) => ({ login, on: [...on] }));
  } catch (error) {
    ctx.log?.(`factory: ${item.id}: reading who commented: ${errorMessage(error)}`);
    return null;
  }
}

/** "@mallory (on #3)" or "@mallory (on #3, #12) and @eve (on #12)". */
export function commentersText(untrusted: readonly UntrustedCommenter[]): string {
  const each = untrusted.map((u) => `${u.login} (on ${u.on.map((n) => `#${n}`).join(", ")})`);
  if (each.length <= 1) return each.join("");
  return `${each.slice(0, -1).join(", ")} and ${each.at(-1)}`;
}
