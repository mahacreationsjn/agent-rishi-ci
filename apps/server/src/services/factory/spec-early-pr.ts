import type {
  FactoryItem,
  FactoryItemStage,
  GitHubPrRef,
  Project,
  Session,
} from "@agent-rishi/contracts";
import { errorMessage } from "../errors";
import type { FactoryContext } from "./context";

/**
 * Pull requests opened before the spec was approved (§10.1, spec approval). `create_pull_request`
 * is refused while an item's spec waits for a person or is being revised (`assertSpecAllowsPr`),
 * but a builder can still run `gh pr create`, and a person can open a PR on its branch. Such a PR
 * isn't adopted while the spec is held: the item stays at its approval step and says why, and
 * the PR is told once that it waits. Once the spec is approved it is adopted as usual. When the
 * work goes on in another PR, or stops without one, it is closed with a comment.
 */

/** `early_pr_<number>`: a PR held while the item's spec was; set once the PR was told. */
const EARLY_PR = "early_pr_";

/** Whether a nudge records a PR held for its spec (it outlives a recovery or a retry). */
export function isEarlyPrRecord(key: string): boolean {
  return key.startsWith(EARLY_PR);
}

/** What the item says while a PR opened before the approval waits for it. */
export function earlyPrNote(pr: GitHubPrRef): string {
  return `A pull request was opened before the spec was approved (#${pr.number})`;
}

/** The builder's open PR: linked to its session, or found on its branch. */
export function builderOpenPr(
  ctx: FactoryContext,
  projectId: string,
  builder: Session,
): GitHubPrRef | null {
  const pr = builder.pr ?? ctx.github.prForSession(projectId, builder.id, builder.branch);
  return pr && (pr.state === "open" || pr.state === "draft") ? pr : null;
}

/**
 * Hold a PR found on the builder's branch while the spec is held: the item says so, and the PR
 * is told once (again on the next tick when GitHub refused the comment). Not adopted.
 */
export async function holdEarlyPr(
  ctx: FactoryContext,
  item: FactoryItem,
  pr: GitHubPrRef,
): Promise<FactoryItem> {
  const key = `${EARLY_PR}${pr.number}`;
  const note = earlyPrNote(pr);
  let told = Boolean(item.nudges[key]);
  if (!told) {
    const on = item.issue ? `#${item.issue.number}` : `"${item.title}"`;
    told = await ctx.github
      .comment(
        item.projectId,
        pr.number,
        `**Agent Rishi software factory**: Waiting for spec approval on ${on}; this PR won't be reviewed or merged until then.`,
      )
      .then(
        () => true,
        (error: unknown) => {
          ctx.log?.(`factory: comment on #${pr.number}: ${errorMessage(error)}`);
          return false;
        },
      );
  }
  if (item.note === note && (item.nudges[key] || !told)) return item;
  const at = ctx.now().toISOString();
  return ctx.store.updateItem(
    item.id,
    (i) => ({
      ...i,
      note,
      nudges: told && !i.nudges[key] ? { ...i.nudges, [key]: at } : i.nudges,
    }),
    { touch: false },
  );
}

/** Stages in which the work stopped: a PR held for its spec has nothing left to wait for. */
const STOPPED: ReadonlySet<FactoryItemStage> = new Set(["rejected", "merged", "reverted"]);

function closing(item: FactoryItem, by: GitHubPrRef | null): string {
  if (by) {
    return `Superseded by #${by.number} (${by.url}), which carries on this work after its spec was approved. Closed by the Agent Rishi factory.`;
  }
  const on = item.issue ? ` on #${item.issue.number}` : "";
  const why = item.reason ? `: ${item.reason}` : "";
  return `**Agent Rishi software factory**: closing this pull request. It was opened before the spec${on} was approved, and that work stopped${why}.`;
}

/**
 * Settle the PRs items held for their spec, each tick, whatever the item's stage: one the item
 * adopted after the approval is its own now; one it no longer stands for (the work went on in
 * another PR, or stopped) is closed with a comment, tried again on the next tick when GitHub
 * refused. While the item still builds, or failed and waits for a person, it waits too.
 */
export async function closeEarlyPrs(ctx: FactoryContext, project: Project): Promise<void> {
  for (const item of ctx.store.items(project.id)) {
    for (const key of Object.keys(item.nudges).filter(isEarlyPrRecord)) {
      const number = Number(key.slice(EARLY_PR.length));
      const adopted = item.pr?.number === number;
      if (!adopted && !item.pr && !STOPPED.has(item.stage)) continue;
      const state = ctx.github.prRef(project.id, number)?.state ?? "open";
      if (!adopted && (state === "open" || state === "draft")) {
        try {
          await ctx.github.closePr(project.id, number, closing(item, item.pr));
        } catch (error) {
          ctx.log?.(`factory: closing #${number}: ${errorMessage(error)}`);
          continue;
        }
      }
      ctx.store.updateItem(
        item.id,
        (i) => {
          const { [key]: _settled, ...nudges } = i.nudges;
          return { ...i, nudges };
        },
        { touch: false },
      );
    }
  }
}
