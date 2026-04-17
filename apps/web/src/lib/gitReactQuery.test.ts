import { QueryClient } from "@tanstack/react-query";
import { describe, expect, it, vi } from "vitest";

vi.mock("../nativeApi", () => ({
  ensureNativeApi: vi.fn(),
}));

vi.mock("../wsRpcClient", () => ({
  getWsRpcClient: vi.fn(),
}));

import type { InfiniteData } from "@tanstack/react-query";
import type { GitListBranchesResult, GitResolvedPullRequest } from "contracts";

import {
  gitBranchSearchInfiniteQueryOptions,
  gitMutationKeys,
  gitPullRequestSummaryQueryOptions,
  gitQueryKeys,
  gitPreparePullRequestThreadMutationOptions,
  invalidateGitStatusQuery,
  gitStatusQueryOptions,
  invalidateGitQueries,
} from "./gitReactQuery";

const BRANCH_QUERY_RESULT: GitListBranchesResult = {
  branches: [],
  isRepo: true,
  hasOriginRemote: true,
  nextCursor: null,
  totalCount: 0,
};

const BRANCH_SEARCH_RESULT: InfiniteData<GitListBranchesResult, number> = {
  pages: [BRANCH_QUERY_RESULT],
  pageParams: [0],
};

const PULL_REQUEST: GitResolvedPullRequest = {
  number: 17,
  title: "Speed up PR summaries",
  url: "https://github.com/example/repo/pull/17",
  baseBranch: "main",
  headBranch: "feature/speed-up-pr-summaries",
  state: "open",
};

describe("gitMutationKeys", () => {
  it("scopes pull request thread preparation keys by cwd", () => {
    expect(gitMutationKeys.preparePullRequestThread("/repo/a")).not.toEqual(
      gitMutationKeys.preparePullRequestThread("/repo/b"),
    );
  });
});

describe("git mutation options", () => {
  const queryClient = new QueryClient();

  it("attaches cwd-scoped mutation key for preparePullRequestThread", () => {
    const options = gitPreparePullRequestThreadMutationOptions({
      cwd: "/repo/a",
      queryClient,
    });
    expect(options.mutationKey).toEqual(gitMutationKeys.preparePullRequestThread("/repo/a"));
  });
});

describe("invalidateGitQueries", () => {
  it("can invalidate a single cwd without blasting other git query scopes", async () => {
    const queryClient = new QueryClient();

    queryClient.setQueryData(gitQueryKeys.status("/repo/a"), { ok: "a" });
    queryClient.setQueryData(
      gitBranchSearchInfiniteQueryOptions({
        cwd: "/repo/a",
        query: "feature",
      }).queryKey,
      BRANCH_SEARCH_RESULT,
    );
    queryClient.setQueryData(gitQueryKeys.status("/repo/b"), { ok: "b" });
    queryClient.setQueryData(
      gitBranchSearchInfiniteQueryOptions({
        cwd: "/repo/b",
        query: "feature",
      }).queryKey,
      BRANCH_SEARCH_RESULT,
    );

    await invalidateGitQueries(queryClient, { cwd: "/repo/a" });

    expect(
      queryClient.getQueryState(gitStatusQueryOptions("/repo/a").queryKey)?.isInvalidated,
    ).toBe(true);
    expect(
      queryClient.getQueryState(
        gitBranchSearchInfiniteQueryOptions({
          cwd: "/repo/a",
          query: "feature",
        }).queryKey,
      )?.isInvalidated,
    ).toBe(true);
    expect(
      queryClient.getQueryState(gitStatusQueryOptions("/repo/b").queryKey)?.isInvalidated,
    ).toBe(false);
    expect(
      queryClient.getQueryState(
        gitBranchSearchInfiniteQueryOptions({
          cwd: "/repo/b",
          query: "feature",
        }).queryKey,
      )?.isInvalidated,
    ).toBe(false);
  });
});

describe("invalidateGitStatusQuery", () => {
  it("invalidates only status for the selected cwd", async () => {
    const queryClient = new QueryClient();

    queryClient.setQueryData(gitQueryKeys.status("/repo/a"), { ok: "a" });
    queryClient.setQueryData(gitQueryKeys.status("/repo/b"), { ok: "b" });

    await invalidateGitStatusQuery(queryClient, "/repo/a");

    expect(
      queryClient.getQueryState(gitStatusQueryOptions("/repo/a").queryKey)?.isInvalidated,
    ).toBe(true);
    expect(
      queryClient.getQueryState(gitStatusQueryOptions("/repo/b").queryKey)?.isInvalidated,
    ).toBe(false);
  });

  it("disables retries for git status polling", () => {
    const options = gitStatusQueryOptions("/repo/a");

    expect(options.retry).toBe(false);
  });
});

describe("gitPullRequestSummaryQueryOptions", () => {
  it("forwards available pull request metadata to the summary RPC", async () => {
    const summarizePullRequest = vi.fn().mockResolvedValue({ summary: "ok" });
    const { ensureNativeApi } = await import("../nativeApi");
    vi.mocked(ensureNativeApi).mockReturnValue({
      git: {
        summarizePullRequest,
      },
    } as never);

    const options = gitPullRequestSummaryQueryOptions({
      cwd: "/repo/a",
      number: 17,
      pullRequest: PULL_REQUEST,
    });

    const result = await (options.queryFn as () => Promise<unknown>)();

    expect(result).toEqual({ summary: "ok" });
    expect(summarizePullRequest).toHaveBeenCalledWith({
      cwd: "/repo/a",
      number: 17,
      title: "Speed up PR summaries",
      baseBranch: "main",
      headBranch: "feature/speed-up-pr-summaries",
    });
  });
});
