import { describe, expect, it } from "vitest";

import {
  MISSING_THREAD_REDIRECT_GRACE_MS,
  shouldPrewarmThreadSession,
  shouldRedirectMissingThread,
} from "./_chat.$threadId";

describe("shouldPrewarmThreadSession", () => {
  it("prewarms healthy resumed threads with no attached session", () => {
    expect(
      shouldPrewarmThreadSession({
        session: null,
        resumeState: "resumed",
      }),
    ).toBe(true);
  });

  it("does not prewarm threads that explicitly need resume", () => {
    expect(
      shouldPrewarmThreadSession({
        session: {
          orchestrationStatus: "error",
        },
        resumeState: "needs_resume",
      }),
    ).toBe(false);
  });

  it("does not prewarm unrecoverable threads", () => {
    expect(
      shouldPrewarmThreadSession({
        session: {
          orchestrationStatus: "stopped",
        },
        resumeState: "unrecoverable",
      }),
    ).toBe(false);
  });
});

describe("shouldRedirectMissingThread", () => {
  it("does not redirect before bootstrap completes", () => {
    expect(
      shouldRedirectMissingThread({
        bootstrapComplete: false,
        routeThreadExists: false,
        missingSinceMs: 0,
        nowMs: MISSING_THREAD_REDIRECT_GRACE_MS,
      }),
    ).toBe(false);
  });

  it("does not redirect while the thread still exists", () => {
    expect(
      shouldRedirectMissingThread({
        bootstrapComplete: true,
        routeThreadExists: true,
        missingSinceMs: 0,
        nowMs: MISSING_THREAD_REDIRECT_GRACE_MS,
      }),
    ).toBe(false);
  });

  it("waits for the full grace period before redirecting", () => {
    expect(
      shouldRedirectMissingThread({
        bootstrapComplete: true,
        routeThreadExists: false,
        missingSinceMs: 100,
        nowMs: 100 + MISSING_THREAD_REDIRECT_GRACE_MS - 1,
      }),
    ).toBe(false);

    expect(
      shouldRedirectMissingThread({
        bootstrapComplete: true,
        routeThreadExists: false,
        missingSinceMs: 100,
        nowMs: 100 + MISSING_THREAD_REDIRECT_GRACE_MS,
      }),
    ).toBe(true);
  });
});
