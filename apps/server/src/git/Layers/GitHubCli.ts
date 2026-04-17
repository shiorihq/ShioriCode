import { Effect, Layer, Schema } from "effect";
import { PositiveInt, TrimmedNonEmptyString } from "contracts";

import { runProcess } from "../../processRunner";
import { GitHubCliError } from "contracts";
import {
  GitHubCli,
  type GitHubPullRequestComment,
  type GitHubPullRequestConversation,
  type GitHubPullRequestReview,
  type GitHubPullRequestReviewState,
  type GitHubPullRequestSummary,
  type GitHubRepositoryCloneUrls,
  type GitHubCliShape,
} from "../Services/GitHubCli.ts";

const DEFAULT_TIMEOUT_MS = 30_000;

function normalizeGitHubCliError(operation: "execute" | "stdout", error: unknown): GitHubCliError {
  if (error instanceof Error) {
    if (error.message.includes("Command not found: gh")) {
      return new GitHubCliError({
        operation,
        detail: "GitHub CLI (`gh`) is required but not available on PATH.",
        cause: error,
      });
    }

    const lower = error.message.toLowerCase();
    if (
      lower.includes("authentication failed") ||
      lower.includes("not logged in") ||
      lower.includes("gh auth login") ||
      lower.includes("no oauth token")
    ) {
      return new GitHubCliError({
        operation,
        detail: "GitHub CLI is not authenticated. Run `gh auth login` and retry.",
        cause: error,
      });
    }

    if (
      lower.includes("could not resolve to a pullrequest") ||
      lower.includes("repository.pullrequest") ||
      lower.includes("no pull requests found for branch") ||
      lower.includes("pull request not found")
    ) {
      return new GitHubCliError({
        operation,
        detail: "Pull request not found. Check the PR number or URL and try again.",
        cause: error,
      });
    }

    return new GitHubCliError({
      operation,
      detail: `GitHub CLI command failed: ${error.message}`,
      cause: error,
    });
  }

  return new GitHubCliError({
    operation,
    detail: "GitHub CLI command failed.",
    cause: error,
  });
}

function normalizePullRequestState(input: {
  state?: string | null | undefined;
  mergedAt?: string | null | undefined;
}): "open" | "closed" | "merged" {
  const mergedAt = input.mergedAt;
  const state = input.state;
  if ((typeof mergedAt === "string" && mergedAt.trim().length > 0) || state === "MERGED") {
    return "merged";
  }
  if (state === "CLOSED") {
    return "closed";
  }
  return "open";
}

const RawGitHubPullRequestSchema = Schema.Struct({
  number: PositiveInt,
  title: TrimmedNonEmptyString,
  url: TrimmedNonEmptyString,
  baseRefName: TrimmedNonEmptyString,
  headRefName: TrimmedNonEmptyString,
  state: Schema.optional(Schema.NullOr(Schema.String)),
  mergedAt: Schema.optional(Schema.NullOr(Schema.String)),
  isDraft: Schema.optional(Schema.Boolean),
  isCrossRepository: Schema.optional(Schema.Boolean),
  headRepository: Schema.optional(
    Schema.NullOr(
      Schema.Struct({
        nameWithOwner: Schema.String,
      }),
    ),
  ),
  headRepositoryOwner: Schema.optional(
    Schema.NullOr(
      Schema.Struct({
        login: Schema.String,
      }),
    ),
  ),
});

const RawGitHubRepositoryCloneUrlsSchema = Schema.Struct({
  nameWithOwner: TrimmedNonEmptyString,
  url: TrimmedNonEmptyString,
  sshUrl: TrimmedNonEmptyString,
});

function normalizePullRequestSummary(
  raw: Schema.Schema.Type<typeof RawGitHubPullRequestSchema>,
): GitHubPullRequestSummary {
  const headRepositoryNameWithOwner = raw.headRepository?.nameWithOwner ?? null;
  const headRepositoryOwnerLogin =
    raw.headRepositoryOwner?.login ??
    (typeof headRepositoryNameWithOwner === "string" && headRepositoryNameWithOwner.includes("/")
      ? (headRepositoryNameWithOwner.split("/")[0] ?? null)
      : null);
  return {
    number: raw.number,
    title: raw.title,
    url: raw.url,
    baseRefName: raw.baseRefName,
    headRefName: raw.headRefName,
    state: normalizePullRequestState(raw),
    ...(typeof raw.isDraft === "boolean" ? { isDraft: raw.isDraft } : {}),
    ...(typeof raw.isCrossRepository === "boolean"
      ? { isCrossRepository: raw.isCrossRepository }
      : {}),
    ...(headRepositoryNameWithOwner ? { headRepositoryNameWithOwner } : {}),
    ...(headRepositoryOwnerLogin ? { headRepositoryOwnerLogin } : {}),
  };
}

function normalizeRepositoryCloneUrls(
  raw: Schema.Schema.Type<typeof RawGitHubRepositoryCloneUrlsSchema>,
): GitHubRepositoryCloneUrls {
  return {
    nameWithOwner: raw.nameWithOwner,
    url: raw.url,
    sshUrl: raw.sshUrl,
  };
}

const RawGitHubAuthor = Schema.optional(
  Schema.NullOr(
    Schema.Struct({
      login: Schema.optional(Schema.NullOr(Schema.String)),
    }),
  ),
);

const RawGitHubPullRequestCommentSchema = Schema.Struct({
  id: Schema.optional(Schema.NullOr(Schema.String)),
  author: RawGitHubAuthor,
  body: Schema.optional(Schema.NullOr(Schema.String)),
  createdAt: Schema.optional(Schema.NullOr(Schema.String)),
  url: Schema.optional(Schema.NullOr(Schema.String)),
});

const RawGitHubPullRequestReviewSchema = Schema.Struct({
  id: Schema.optional(Schema.NullOr(Schema.String)),
  author: RawGitHubAuthor,
  body: Schema.optional(Schema.NullOr(Schema.String)),
  state: Schema.optional(Schema.NullOr(Schema.String)),
  submittedAt: Schema.optional(Schema.NullOr(Schema.String)),
  url: Schema.optional(Schema.NullOr(Schema.String)),
});

const RawGitHubPullRequestConversationSchema = Schema.Struct({
  body: Schema.optional(Schema.NullOr(Schema.String)),
  author: RawGitHubAuthor,
  createdAt: Schema.optional(Schema.NullOr(Schema.String)),
  comments: Schema.optional(Schema.NullOr(Schema.Array(RawGitHubPullRequestCommentSchema))),
  reviews: Schema.optional(Schema.NullOr(Schema.Array(RawGitHubPullRequestReviewSchema))),
});

function normalizeReviewState(raw: string | null | undefined): GitHubPullRequestReviewState {
  const value = (raw ?? "").trim().toUpperCase();
  if (value === "APPROVED") return "approved";
  if (value === "CHANGES_REQUESTED") return "changes_requested";
  if (value === "DISMISSED") return "dismissed";
  if (value === "PENDING") return "pending";
  return "commented";
}

function normalizeConversation(
  raw: Schema.Schema.Type<typeof RawGitHubPullRequestConversationSchema>,
  fallbackKeyPrefix: string,
): GitHubPullRequestConversation {
  const comments: GitHubPullRequestComment[] = (raw.comments ?? [])
    .map((entry, index) => {
      const body = (entry.body ?? "").trim();
      if (body.length === 0) return null;
      const comment: GitHubPullRequestComment = {
        id: entry.id ?? `${fallbackKeyPrefix}:comment:${index}`,
        author: entry.author?.login ?? null,
        body,
        createdAt: entry.createdAt ?? "",
      };
      return entry.url ? Object.assign(comment, { url: entry.url }) : comment;
    })
    .filter((entry): entry is GitHubPullRequestComment => entry !== null);

  const reviews: GitHubPullRequestReview[] = (raw.reviews ?? []).map((entry, index) => {
    const review: GitHubPullRequestReview = {
      id: entry.id ?? `${fallbackKeyPrefix}:review:${index}`,
      author: entry.author?.login ?? null,
      body: (entry.body ?? "").trim(),
      state: normalizeReviewState(entry.state),
      submittedAt: entry.submittedAt ?? "",
    };
    return entry.url ? Object.assign(review, { url: entry.url }) : review;
  });

  return {
    description: (raw.body ?? "").trim(),
    descriptionAuthor: raw.author?.login ?? null,
    descriptionCreatedAt: raw.createdAt ?? null,
    comments,
    reviews,
  };
}

function decodeGitHubJson<S extends Schema.Top>(
  raw: string,
  schema: S,
  operation:
    | "listOpenPullRequests"
    | "getPullRequest"
    | "getRepositoryCloneUrls"
    | "getPullRequestConversation",
  invalidDetail: string,
): Effect.Effect<S["Type"], GitHubCliError, S["DecodingServices"]> {
  return Schema.decodeEffect(Schema.fromJsonString(schema))(raw).pipe(
    Effect.mapError(
      (error) =>
        new GitHubCliError({
          operation,
          detail: error instanceof Error ? `${invalidDetail}: ${error.message}` : invalidDetail,
          cause: error,
        }),
    ),
  );
}

const makeGitHubCli = Effect.sync(() => {
  const execute: GitHubCliShape["execute"] = (input) =>
    Effect.tryPromise({
      try: () =>
        runProcess("gh", input.args, {
          cwd: input.cwd,
          timeoutMs: input.timeoutMs ?? DEFAULT_TIMEOUT_MS,
        }),
      catch: (error) => normalizeGitHubCliError("execute", error),
    });

  const service = {
    execute,
    listOpenPullRequests: (input) =>
      execute({
        cwd: input.cwd,
        args: [
          "pr",
          "list",
          "--head",
          input.headSelector,
          "--state",
          "open",
          "--limit",
          String(input.limit ?? 1),
          "--json",
          "number,title,url,baseRefName,headRefName,state,mergedAt,isDraft,isCrossRepository,headRepository,headRepositoryOwner",
        ],
      }).pipe(
        Effect.map((result) => result.stdout.trim()),
        Effect.flatMap((raw) =>
          raw.length === 0
            ? Effect.succeed([])
            : decodeGitHubJson(
                raw,
                Schema.Array(RawGitHubPullRequestSchema),
                "listOpenPullRequests",
                "GitHub CLI returned invalid PR list JSON.",
              ),
        ),
        Effect.map((pullRequests) => pullRequests.map(normalizePullRequestSummary)),
      ),
    listPullRequests: (input) => {
      const filter = input.filter ?? "open";
      const args = [
        "pr",
        "list",
        "--state",
        filter === "closed" ? "all" : "open",
        "--limit",
        String(input.limit ?? 100),
        "--json",
        "number,title,url,baseRefName,headRefName,state,mergedAt,isDraft,isCrossRepository,headRepository,headRepositoryOwner",
      ];
      if (filter === "draft") {
        args.push("--search", "draft:true");
      }
      return execute({
        cwd: input.cwd,
        args,
      }).pipe(
        Effect.map((result) => result.stdout.trim()),
        Effect.flatMap((raw) =>
          raw.length === 0
            ? Effect.succeed([])
            : decodeGitHubJson(
                raw,
                Schema.Array(RawGitHubPullRequestSchema),
                "listOpenPullRequests",
                "GitHub CLI returned invalid PR list JSON.",
              ),
        ),
        Effect.map((pullRequests) => pullRequests.map(normalizePullRequestSummary)),
      );
    },
    getPullRequestDiff: (input) =>
      execute({
        cwd: input.cwd,
        args: ["pr", "diff", String(input.number)],
        timeoutMs: 60_000,
      }).pipe(Effect.map((result) => result.stdout)),
    getPullRequestConversation: (input) =>
      execute({
        cwd: input.cwd,
        args: [
          "pr",
          "view",
          String(input.number),
          "--json",
          "body,author,createdAt,comments,reviews",
        ],
      }).pipe(
        Effect.map((result) => result.stdout.trim()),
        Effect.flatMap((raw) =>
          raw.length === 0
            ? Effect.succeed({
                body: null,
                author: null,
                createdAt: null,
                comments: null,
                reviews: null,
              } as Schema.Schema.Type<typeof RawGitHubPullRequestConversationSchema>)
            : decodeGitHubJson(
                raw,
                RawGitHubPullRequestConversationSchema,
                "getPullRequestConversation",
                "GitHub CLI returned invalid pull request conversation JSON.",
              ),
        ),
        Effect.map((raw) => normalizeConversation(raw, `pr-${input.number}`)),
      ),
    getPullRequest: (input) =>
      execute({
        cwd: input.cwd,
        args: [
          "pr",
          "view",
          input.reference,
          "--json",
          "number,title,url,baseRefName,headRefName,state,mergedAt,isDraft,isCrossRepository,headRepository,headRepositoryOwner",
        ],
      }).pipe(
        Effect.map((result) => result.stdout.trim()),
        Effect.flatMap((raw) =>
          decodeGitHubJson(
            raw,
            RawGitHubPullRequestSchema,
            "getPullRequest",
            "GitHub CLI returned invalid pull request JSON.",
          ),
        ),
        Effect.map(normalizePullRequestSummary),
      ),
    getRepositoryCloneUrls: (input) =>
      execute({
        cwd: input.cwd,
        args: ["repo", "view", input.repository, "--json", "nameWithOwner,url,sshUrl"],
      }).pipe(
        Effect.map((result) => result.stdout.trim()),
        Effect.flatMap((raw) =>
          decodeGitHubJson(
            raw,
            RawGitHubRepositoryCloneUrlsSchema,
            "getRepositoryCloneUrls",
            "GitHub CLI returned invalid repository JSON.",
          ),
        ),
        Effect.map(normalizeRepositoryCloneUrls),
      ),
    createPullRequest: (input) =>
      execute({
        cwd: input.cwd,
        args: [
          "pr",
          "create",
          "--base",
          input.baseBranch,
          "--head",
          input.headSelector,
          "--title",
          input.title,
          "--body-file",
          input.bodyFile,
        ],
      }).pipe(Effect.asVoid),
    getDefaultBranch: (input) =>
      execute({
        cwd: input.cwd,
        args: ["repo", "view", "--json", "defaultBranchRef", "--jq", ".defaultBranchRef.name"],
      }).pipe(
        Effect.map((value) => {
          const trimmed = value.stdout.trim();
          return trimmed.length > 0 ? trimmed : null;
        }),
      ),
    checkoutPullRequest: (input) =>
      execute({
        cwd: input.cwd,
        args: ["pr", "checkout", input.reference, ...(input.force ? ["--force"] : [])],
      }).pipe(Effect.asVoid),
  } satisfies GitHubCliShape;

  return service;
});

export const GitHubCliLive = Layer.effect(GitHubCli, makeGitHubCli);
