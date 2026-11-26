import type { GithubService } from "../github/github-service";
import { authorAssociation } from "../github/graphql";
import type { Commenter } from "./github-port";

/**
 * Who commented on an issue or pull request, for the factory's trust checks (`comment-trust.ts`):
 * on a public repository anyone can comment, and builders and reviewers read what they wrote.
 */

/** What GitHub's comment and review listings say about their author. */
interface Authored {
  user?: { login: string } | null;
  author_association?: string | null;
}

const commenter = (c: Authored): Commenter => ({
  login: c.user?.login ?? null,
  association: authorAssociation(c.author_association),
});

/**
 * One entry per comment on the issue or pull request's conversation and, for a pull request
 * (`pr`), per review and review comment.
 */
export async function commenters(
  github: GithubService,
  projectId: string,
  number: number,
  pr: boolean,
): Promise<Commenter[]> {
  const { owner, repo } = github.githubRepo(projectId);
  return github.client.run(async (o) => {
    const page = { owner, repo, per_page: 100 } as const;
    const conversation = await o.paginate(o.rest.issues.listComments, {
      ...page,
      issue_number: number,
    });
    if (!pr) return conversation.map(commenter);
    const [reviews, inline] = await Promise.all([
      o.paginate(o.rest.pulls.listReviews, { ...page, pull_number: number }),
      o.paginate(o.rest.pulls.listReviewComments, { ...page, pull_number: number }),
    ]);
    return [...conversation, ...reviews, ...inline].map(commenter);
  });
}
