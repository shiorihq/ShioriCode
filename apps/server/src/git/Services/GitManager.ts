/**
 * GitManager - Effect service contract for stacked Git workflows.
 *
 * Orchestrates status inspection and commit/push/PR flows by composing
 * lower-level Git and external tool services.
 *
 * @module GitManager
 */
import {
  GitActionProgressEvent,
  GitListOpenPullRequestsInput,
  GitListOpenPullRequestsResult,
  GitPreparePullRequestThreadInput,
  GitPreparePullRequestThreadResult,
  GitPullRequestConversationInput,
  GitPullRequestConversationResult,
  GitPullRequestDiffInput,
  GitPullRequestDiffResult,
  GitPullRequestRefInput,
  GitResolvePullRequestResult,
  GitRunStackedActionInput,
  GitRunStackedActionResult,
  GitStatusInput,
  GitStatusResult,
  GitSummarizePullRequestInput,
  GitSummarizePullRequestResult,
} from "contracts";
import { ServiceMap } from "effect";
import type { Effect } from "effect";
import type { GitManagerServiceError } from "contracts";

export interface GitActionProgressReporter {
  readonly publish: (event: GitActionProgressEvent) => Effect.Effect<void, never>;
}

export interface GitRunStackedActionOptions {
  readonly actionId?: string;
  readonly progressReporter?: GitActionProgressReporter;
}

/**
 * GitManagerShape - Service API for high-level Git workflow actions.
 */
export interface GitManagerShape {
  /**
   * Read current repository Git status plus open PR metadata when available.
   */
  readonly status: (
    input: GitStatusInput,
  ) => Effect.Effect<GitStatusResult, GitManagerServiceError>;

  /**
   * Resolve a pull request by URL/number against the current repository.
   */
  readonly resolvePullRequest: (
    input: GitPullRequestRefInput,
  ) => Effect.Effect<GitResolvePullRequestResult, GitManagerServiceError>;

  /**
   * Prepare a new thread workspace from a pull request in local or worktree mode.
   */
  readonly preparePullRequestThread: (
    input: GitPreparePullRequestThreadInput,
  ) => Effect.Effect<GitPreparePullRequestThreadResult, GitManagerServiceError>;

  /**
   * List every open pull request for the repository at `cwd`.
   */
  readonly listOpenPullRequests: (
    input: GitListOpenPullRequestsInput,
  ) => Effect.Effect<GitListOpenPullRequestsResult, GitManagerServiceError>;

  /**
   * Fetch the unified diff for a pull request by its number.
   */
  readonly getPullRequestDiff: (
    input: GitPullRequestDiffInput,
  ) => Effect.Effect<GitPullRequestDiffResult, GitManagerServiceError>;

  /**
   * Summarize a pull request's changes using the default text generation model.
   */
  readonly summarizePullRequest: (
    input: GitSummarizePullRequestInput,
  ) => Effect.Effect<GitSummarizePullRequestResult, GitManagerServiceError>;

  /**
   * Fetch the conversation timeline (description, comments, review submissions)
   * for a pull request.
   */
  readonly getPullRequestConversation: (
    input: GitPullRequestConversationInput,
  ) => Effect.Effect<GitPullRequestConversationResult, GitManagerServiceError>;

  /**
   * Run a Git action (`commit`, `push`, `create_pr`, `commit_push`, `commit_push_pr`).
   * When `featureBranch` is set, creates and checks out a feature branch first.
   */
  readonly runStackedAction: (
    input: GitRunStackedActionInput,
    options?: GitRunStackedActionOptions,
  ) => Effect.Effect<GitRunStackedActionResult, GitManagerServiceError>;
}

/**
 * GitManager - Service tag for stacked Git workflow orchestration.
 */
export class GitManager extends ServiceMap.Service<GitManager, GitManagerShape>()(
  "t3/git/Services/GitManager",
) {}
