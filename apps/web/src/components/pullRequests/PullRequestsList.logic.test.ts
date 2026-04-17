import { describe, expect, it } from "vitest";

import {
  filterPullRequests,
  formatPullRequestCountLabel,
  getPullRequestEmptyStateCopy,
  getPullRequestStatusTone,
  shouldExpandProjectByDefault,
} from "./PullRequestsList.logic";

const pullRequests = [
  {
    number: 1,
    title: "Open PR",
    url: "https://example.com/1",
    baseBranch: "main",
    headBranch: "feature/open",
    state: "open" as const,
  },
  {
    number: 2,
    title: "Draft PR",
    url: "https://example.com/2",
    baseBranch: "main",
    headBranch: "feature/draft",
    state: "open" as const,
    isDraft: true,
  },
  {
    number: 3,
    title: "Merged PR",
    url: "https://example.com/3",
    baseBranch: "main",
    headBranch: "feature/merged",
    state: "merged" as const,
  },
] as const;

describe("filterPullRequests", () => {
  it("returns all open pull requests for the open filter", () => {
    expect(filterPullRequests(pullRequests, "open").map((pr) => pr.number)).toEqual([1, 2]);
  });

  it("returns only closed or merged pull requests for the closed filter", () => {
    expect(filterPullRequests(pullRequests, "closed").map((pr) => pr.number)).toEqual([3]);
  });

  it("returns only draft pull requests for the draft filter", () => {
    expect(filterPullRequests(pullRequests, "draft").map((pr) => pr.number)).toEqual([2]);
  });
});

describe("shouldExpandProjectByDefault", () => {
  it("collapses projects without visible pull requests", () => {
    expect(shouldExpandProjectByDefault({ status: "success", visiblePullRequestsCount: 0 })).toBe(
      false,
    );
    expect(shouldExpandProjectByDefault({ status: "success", visiblePullRequestsCount: 2 })).toBe(
      true,
    );
    expect(shouldExpandProjectByDefault({ status: "loading", visiblePullRequestsCount: 0 })).toBe(
      true,
    );
  });
});

describe("getPullRequestStatusTone", () => {
  it("returns 'open' for ready-to-review open PRs", () => {
    expect(getPullRequestStatusTone({ state: "open", isDraft: false })).toBe("open");
    expect(getPullRequestStatusTone({ state: "open" })).toBe("open");
  });

  it("returns 'draft' for open PRs marked as draft", () => {
    expect(getPullRequestStatusTone({ state: "open", isDraft: true })).toBe("draft");
  });

  it("returns 'merged' and 'closed' based on terminal state regardless of draft flag", () => {
    expect(getPullRequestStatusTone({ state: "merged", isDraft: true })).toBe("merged");
    expect(getPullRequestStatusTone({ state: "closed", isDraft: true })).toBe("closed");
  });
});

describe("list copy helpers", () => {
  it("formats the count label for each filter", () => {
    expect(formatPullRequestCountLabel("open", 2)).toBe("2 open PRs");
    expect(formatPullRequestCountLabel("draft", 1)).toBe("1 draft PR");
  });

  it("returns filter-aware empty states", () => {
    expect(getPullRequestEmptyStateCopy("closed").title).toBe("No closed pull requests");
    expect(getPullRequestEmptyStateCopy("draft").title).toBe("No draft pull requests");
  });
});
