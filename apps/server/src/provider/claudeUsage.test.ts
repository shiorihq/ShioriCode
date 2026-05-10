import { afterEach, describe, expect, it, vi } from "vitest";

import { fetchClaudeUsageSnapshot } from "./claudeUsage.ts";

const ORIGINAL_ENV = { ...process.env };

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  process.env = { ...ORIGINAL_ENV };
});

describe("fetchClaudeUsageSnapshot", () => {
  it("returns unavailable when the Claude usage API rate-limits", async () => {
    process.env.CLAUDE_CODE_OAUTH_TOKEN = "oauth-token";
    const fetchMock = vi.fn(async () => new Response("rate limited", { status: 429 }));
    vi.stubGlobal("fetch", fetchMock);

    const usage = await fetchClaudeUsageSnapshot();

    expect(usage.available).toBe(false);
    expect(usage.unavailableReason).toContain("temporarily unavailable (429)");
  });

  it("returns unavailable when the Claude usage API returns a server error", async () => {
    process.env.CLAUDE_CODE_OAUTH_TOKEN = "oauth-token";
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("oops", { status: 503 })),
    );

    const usage = await fetchClaudeUsageSnapshot();

    expect(usage.available).toBe(false);
    expect(usage.unavailableReason).toContain("temporarily unavailable (503)");
  });

  it("returns unavailable when the Claude usage request times out or rejects", async () => {
    process.env.CLAUDE_CODE_OAUTH_TOKEN = "oauth-token";
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new DOMException("signal timed out", "TimeoutError");
      }),
    );

    const usage = await fetchClaudeUsageSnapshot();

    expect(usage.available).toBe(false);
    expect(usage.unavailableReason).toBe("Claude usage request timed out.");
  });
});
