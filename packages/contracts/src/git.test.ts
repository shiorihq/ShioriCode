import { describe, expect, it } from "vitest";
import { Schema } from "effect";

import {
  GitCreateWorktreeInput,
  GitListOpenPullRequestsInput,
  GitPreparePullRequestThreadInput,
  GitResolvePullRequestResult,
} from "./git";

const decodeCreateWorktreeInput = Schema.decodeUnknownSync(GitCreateWorktreeInput);
const decodeListOpenPullRequestsInput = Schema.decodeUnknownSync(GitListOpenPullRequestsInput);
const decodePreparePullRequestThreadInput = Schema.decodeUnknownSync(
  GitPreparePullRequestThreadInput,
);
const decodeResolvePullRequestResult = Schema.decodeUnknownSync(GitResolvePullRequestResult);

describe("GitCreateWorktreeInput", () => {
  it("accepts omitted newBranch for existing-branch worktrees", () => {
    const parsed = decodeCreateWorktreeInput({
      cwd: "/repo",
      branch: "feature/existing",
      path: "/tmp/worktree",
    });

    expect(parsed.newBranch).toBeUndefined();
    expect(parsed.branch).toBe("feature/existing");
  });
});

describe("GitPreparePullRequestThreadInput", () => {
  it("accepts pull request references and mode", () => {
    const parsed = decodePreparePullRequestThreadInput({
      cwd: "/repo",
      reference: "#42",
      mode: "worktree",
    });

    expect(parsed.reference).toBe("#42");
    expect(parsed.mode).toBe("worktree");
  });
});

describe("GitListOpenPullRequestsInput", () => {
  it("accepts a pull request filter", () => {
    const parsed = decodeListOpenPullRequestsInput({
      cwd: "/repo",
      filter: "draft",
    });

    expect(parsed.filter).toBe("draft");
  });
});

describe("GitResolvePullRequestResult", () => {
  it("decodes resolved pull request metadata", () => {
    const parsed = decodeResolvePullRequestResult({
      pullRequest: {
        number: 42,
        title: "PR threads",
        url: "https://github.com/pingdotgg/codething-mvp/pull/42",
        baseBranch: "main",
        headBranch: "feature/pr-threads",
        state: "open",
        isDraft: true,
      },
    });

    expect(parsed.pullRequest.number).toBe(42);
    expect(parsed.pullRequest.headBranch).toBe("feature/pr-threads");
    expect(parsed.pullRequest.isDraft).toBe(true);
  });
});
