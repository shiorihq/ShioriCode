import type { GitPullRequestListFilter, GitResolvedPullRequest } from "contracts";

export const PULL_REQUEST_FILTER_LABELS: Record<GitPullRequestListFilter, string> = {
  open: "Open",
  closed: "Closed",
  draft: "Draft",
};

export type PullRequestStatusTone = "open" | "draft" | "merged" | "closed";

export function getPullRequestStatusTone(
  pullRequest: Pick<GitResolvedPullRequest, "state" | "isDraft">,
): PullRequestStatusTone {
  if (pullRequest.state === "merged") return "merged";
  if (pullRequest.state === "closed") return "closed";
  return pullRequest.isDraft === true ? "draft" : "open";
}

export function filterPullRequests(
  pullRequests: readonly GitResolvedPullRequest[],
  filter: GitPullRequestListFilter,
): readonly GitResolvedPullRequest[] {
  switch (filter) {
    case "closed":
      return pullRequests.filter((pr) => pr.state === "closed" || pr.state === "merged");
    case "draft":
      return pullRequests.filter((pr) => pr.state === "open" && pr.isDraft === true);
    case "open":
    default:
      return pullRequests.filter((pr) => pr.state === "open");
  }
}

export function shouldExpandProjectByDefault(input: {
  status: "loading" | "error" | "success";
  visiblePullRequestsCount: number;
}): boolean {
  if (input.status !== "success") return true;
  return input.visiblePullRequestsCount > 0;
}

export function formatPullRequestCountLabel(
  filter: GitPullRequestListFilter,
  count: number,
): string {
  const noun = count === 1 ? "PR" : "PRs";
  return `${count} ${filter} ${noun}`;
}

export function getPullRequestEmptyStateCopy(filter: GitPullRequestListFilter): {
  title: string;
  description: string;
} {
  switch (filter) {
    case "closed":
      return {
        title: "No closed pull requests",
        description: "Closed and merged pull requests from your projects will show up here.",
      };
    case "draft":
      return {
        title: "No draft pull requests",
        description: "Draft pull requests from your projects will show up here.",
      };
    case "open":
    default:
      return {
        title: "No open pull requests",
        description: "Open a PR from any of your projects and it will show up here.",
      };
  }
}
