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

function extractPullRequestQueryErrorMessage(error: unknown): string | null {
  if (error instanceof Error && error.message.trim().length > 0) {
    return error.message;
  }
  return typeof error === "string" && error.trim().length > 0 ? error : null;
}

export function isPullRequestAuthError(message: string): boolean {
  const lower = message.toLowerCase();
  return (
    lower.includes("not authenticated") ||
    lower.includes("gh auth login") ||
    lower.includes("no oauth token")
  );
}

export function isPullRequestGhMissingError(message: string): boolean {
  const lower = message.toLowerCase();
  return lower.includes("command not found: gh") || lower.includes("gh`) is required");
}

export function describePullRequestQueryError(error: unknown): string {
  const message = extractPullRequestQueryErrorMessage(error);
  if (!message) {
    return "Failed to load pull requests.";
  }

  if (message.toLowerCase().includes("not a git repository")) {
    return "Pull requests are unavailable because this project is not a git repository.";
  }

  if (isPullRequestGhMissingError(message)) {
    return "GitHub CLI (`gh`) is required to view pull requests for this project.";
  }

  if (isPullRequestAuthError(message)) {
    return "Authenticate GitHub CLI with `gh auth login` to view pull requests for this project.";
  }

  return message;
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
