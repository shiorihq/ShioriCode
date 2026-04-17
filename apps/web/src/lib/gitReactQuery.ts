import {
  infiniteQueryOptions,
  mutationOptions,
  queryOptions,
  type QueryClient,
} from "@tanstack/react-query";
import type { GitPullRequestListFilter, GitResolvedPullRequest } from "contracts";
import { ensureNativeApi } from "../nativeApi";

const GIT_STATUS_STALE_TIME_MS = 5_000;
const GIT_STATUS_REFETCH_INTERVAL_MS = 15_000;
const GIT_BRANCHES_STALE_TIME_MS = 15_000;
const GIT_BRANCHES_REFETCH_INTERVAL_MS = 60_000;
const GIT_BRANCHES_PAGE_SIZE = 100;
const GIT_OPEN_PRS_STALE_TIME_MS = 30_000;
const GIT_OPEN_PRS_REFETCH_INTERVAL_MS = 120_000;
const GIT_PR_DIFF_STALE_TIME_MS = 60_000;
const GIT_PR_SUMMARY_STALE_TIME_MS = 60 * 60_000;
const GIT_PR_CONVERSATION_STALE_TIME_MS = 60_000;

export const gitQueryKeys = {
  all: ["git"] as const,
  status: (cwd: string | null) => ["git", "status", cwd] as const,
  branches: (cwd: string | null) => ["git", "branches", cwd] as const,
  branchSearch: (cwd: string | null, query: string) =>
    ["git", "branches", cwd, "search", query] as const,
  openPullRequests: (cwd: string | null, filter: GitPullRequestListFilter) =>
    ["git", "pull-requests", cwd, filter] as const,
  pullRequestDiff: (cwd: string | null, number: number | null) =>
    ["git", "pull-requests", cwd, number, "diff"] as const,
  pullRequestSummary: (cwd: string | null, number: number | null) =>
    ["git", "pull-requests", cwd, number, "summary"] as const,
  pullRequestConversation: (cwd: string | null, number: number | null) =>
    ["git", "pull-requests", cwd, number, "conversation"] as const,
};

export const gitMutationKeys = {
  init: (cwd: string | null) => ["git", "mutation", "init", cwd] as const,
  checkout: (cwd: string | null) => ["git", "mutation", "checkout", cwd] as const,
  preparePullRequestThread: (cwd: string | null) =>
    ["git", "mutation", "prepare-pull-request-thread", cwd] as const,
};

export function invalidateGitQueries(queryClient: QueryClient, input?: { cwd?: string | null }) {
  const cwd = input?.cwd ?? null;
  if (cwd !== null) {
    return Promise.all([
      queryClient.invalidateQueries({ queryKey: gitQueryKeys.status(cwd) }),
      queryClient.invalidateQueries({ queryKey: gitQueryKeys.branches(cwd) }),
    ]);
  }

  return queryClient.invalidateQueries({ queryKey: gitQueryKeys.all });
}

export function invalidateGitStatusQuery(queryClient: QueryClient, cwd: string | null) {
  if (cwd === null) {
    return Promise.resolve();
  }

  return queryClient.invalidateQueries({ queryKey: gitQueryKeys.status(cwd) });
}

export function gitStatusQueryOptions(cwd: string | null) {
  return queryOptions({
    queryKey: gitQueryKeys.status(cwd),
    queryFn: async () => {
      const api = ensureNativeApi();
      if (!cwd) throw new Error("Git status is unavailable.");
      return api.git.status({ cwd });
    },
    enabled: cwd !== null,
    staleTime: GIT_STATUS_STALE_TIME_MS,
    retry: false,
    refetchOnWindowFocus: "always",
    refetchOnReconnect: "always",
    refetchInterval: GIT_STATUS_REFETCH_INTERVAL_MS,
  });
}

export function gitBranchSearchInfiniteQueryOptions(input: {
  cwd: string | null;
  query: string;
  enabled?: boolean;
}) {
  const normalizedQuery = input.query.trim();

  return infiniteQueryOptions({
    queryKey: gitQueryKeys.branchSearch(input.cwd, normalizedQuery),
    initialPageParam: 0,
    queryFn: async ({ pageParam }) => {
      const api = ensureNativeApi();
      if (!input.cwd) throw new Error("Git branches are unavailable.");
      return api.git.listBranches({
        cwd: input.cwd,
        ...(normalizedQuery.length > 0 ? { query: normalizedQuery } : {}),
        cursor: pageParam,
        limit: GIT_BRANCHES_PAGE_SIZE,
      });
    },
    getNextPageParam: (lastPage) => lastPage.nextCursor ?? undefined,
    enabled: input.cwd !== null && (input.enabled ?? true),
    staleTime: GIT_BRANCHES_STALE_TIME_MS,
    refetchOnWindowFocus: true,
    refetchOnReconnect: true,
    refetchInterval: GIT_BRANCHES_REFETCH_INTERVAL_MS,
  });
}

export function gitOpenPullRequestsQueryOptions(input: {
  cwd: string | null;
  filter: GitPullRequestListFilter;
}) {
  return queryOptions({
    queryKey: gitQueryKeys.openPullRequests(input.cwd, input.filter),
    queryFn: async () => {
      const api = ensureNativeApi();
      if (!input.cwd) throw new Error("Pull request listing is unavailable.");
      return api.git.listOpenPullRequests({ cwd: input.cwd, filter: input.filter });
    },
    enabled: input.cwd !== null,
    staleTime: GIT_OPEN_PRS_STALE_TIME_MS,
    retry: false,
    refetchOnWindowFocus: true,
    refetchOnReconnect: true,
    refetchInterval: GIT_OPEN_PRS_REFETCH_INTERVAL_MS,
  });
}

export function gitPullRequestDiffQueryOptions(input: {
  cwd: string | null;
  number: number | null;
}) {
  return queryOptions({
    queryKey: gitQueryKeys.pullRequestDiff(input.cwd, input.number),
    queryFn: async () => {
      const api = ensureNativeApi();
      if (!input.cwd || input.number === null) {
        throw new Error("Pull request diff is unavailable.");
      }
      return api.git.getPullRequestDiff({ cwd: input.cwd, number: input.number });
    },
    enabled: input.cwd !== null && input.number !== null,
    staleTime: GIT_PR_DIFF_STALE_TIME_MS,
    retry: false,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
  });
}

export function gitPullRequestSummaryQueryOptions(input: {
  cwd: string | null;
  number: number | null;
  pullRequest?: GitResolvedPullRequest | null;
}) {
  return queryOptions({
    queryKey: gitQueryKeys.pullRequestSummary(input.cwd, input.number),
    queryFn: async () => {
      const api = ensureNativeApi();
      if (!input.cwd || input.number === null) {
        throw new Error("Pull request summary is unavailable.");
      }
      return api.git.summarizePullRequest({
        cwd: input.cwd,
        number: input.number,
        ...(input.pullRequest
          ? {
              title: input.pullRequest.title,
              baseBranch: input.pullRequest.baseBranch,
              headBranch: input.pullRequest.headBranch,
            }
          : {}),
      });
    },
    enabled: input.cwd !== null && input.number !== null,
    staleTime: GIT_PR_SUMMARY_STALE_TIME_MS,
    gcTime: GIT_PR_SUMMARY_STALE_TIME_MS,
    retry: false,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
  });
}

export function gitPullRequestConversationQueryOptions(input: {
  cwd: string | null;
  number: number | null;
}) {
  return queryOptions({
    queryKey: gitQueryKeys.pullRequestConversation(input.cwd, input.number),
    queryFn: async () => {
      const api = ensureNativeApi();
      if (!input.cwd || input.number === null) {
        throw new Error("Pull request conversation is unavailable.");
      }
      return api.git.getPullRequestConversation({ cwd: input.cwd, number: input.number });
    },
    enabled: input.cwd !== null && input.number !== null,
    staleTime: GIT_PR_CONVERSATION_STALE_TIME_MS,
    retry: false,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
  });
}

export function gitResolvePullRequestQueryOptions(input: {
  cwd: string | null;
  reference: string | null;
}) {
  return queryOptions({
    queryKey: ["git", "pull-request", input.cwd, input.reference] as const,
    queryFn: async () => {
      const api = ensureNativeApi();
      if (!input.cwd || !input.reference) {
        throw new Error("Pull request lookup is unavailable.");
      }
      return api.git.resolvePullRequest({ cwd: input.cwd, reference: input.reference });
    },
    enabled: input.cwd !== null && input.reference !== null,
    staleTime: 30_000,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
  });
}

export function gitInitMutationOptions(input: { cwd: string | null; queryClient: QueryClient }) {
  return mutationOptions({
    mutationKey: gitMutationKeys.init(input.cwd),
    mutationFn: async () => {
      const api = ensureNativeApi();
      if (!input.cwd) throw new Error("Git init is unavailable.");
      return api.git.init({ cwd: input.cwd });
    },
    onSuccess: async () => {
      await invalidateGitQueries(input.queryClient);
    },
  });
}

export function gitCheckoutMutationOptions(input: {
  cwd: string | null;
  queryClient: QueryClient;
}) {
  return mutationOptions({
    mutationKey: gitMutationKeys.checkout(input.cwd),
    mutationFn: async (branch: string) => {
      const api = ensureNativeApi();
      if (!input.cwd) throw new Error("Git checkout is unavailable.");
      return api.git.checkout({ cwd: input.cwd, branch });
    },
    onSuccess: async () => {
      await invalidateGitQueries(input.queryClient);
    },
  });
}

export function gitCreateWorktreeMutationOptions(input: { queryClient: QueryClient }) {
  return mutationOptions({
    mutationFn: async ({
      cwd,
      branch,
      newBranch,
      path,
    }: {
      cwd: string;
      branch: string;
      newBranch: string;
      path?: string | null;
    }) => {
      const api = ensureNativeApi();
      if (!cwd) throw new Error("Git worktree creation is unavailable.");
      return api.git.createWorktree({ cwd, branch, newBranch, path: path ?? null });
    },
    mutationKey: ["git", "mutation", "create-worktree"] as const,
    onSettled: async () => {
      await invalidateGitQueries(input.queryClient);
    },
  });
}

export function gitRemoveWorktreeMutationOptions(input: { queryClient: QueryClient }) {
  return mutationOptions({
    mutationFn: async ({ cwd, path, force }: { cwd: string; path: string; force?: boolean }) => {
      const api = ensureNativeApi();
      if (!cwd) throw new Error("Git worktree removal is unavailable.");
      return api.git.removeWorktree({ cwd, path, force });
    },
    mutationKey: ["git", "mutation", "remove-worktree"] as const,
    onSettled: async () => {
      await invalidateGitQueries(input.queryClient);
    },
  });
}

export function gitPreparePullRequestThreadMutationOptions(input: {
  cwd: string | null;
  queryClient: QueryClient;
}) {
  return mutationOptions({
    mutationFn: async ({ reference, mode }: { reference: string; mode: "local" | "worktree" }) => {
      const api = ensureNativeApi();
      if (!input.cwd) throw new Error("Pull request thread preparation is unavailable.");
      return api.git.preparePullRequestThread({
        cwd: input.cwd,
        reference,
        mode,
      });
    },
    mutationKey: gitMutationKeys.preparePullRequestThread(input.cwd),
    onSettled: async () => {
      await invalidateGitQueries(input.queryClient);
    },
  });
}
