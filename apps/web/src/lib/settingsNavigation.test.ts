import { describe, expect, it } from "vitest";

import { resolveSettingsBackNavigation } from "./settingsNavigation";

describe("resolveSettingsBackNavigation", () => {
  it("falls back to chat root when no return path exists", () => {
    expect(resolveSettingsBackNavigation(null)).toEqual({ to: "/" });
  });

  it("returns to the pull requests list for pull request routes", () => {
    expect(resolveSettingsBackNavigation("/pull-requests")).toEqual({
      to: "/pull-requests",
    });
  });

  it("returns to a thread route for thread-like paths", () => {
    expect(resolveSettingsBackNavigation("/thread-123")).toEqual({
      to: "/$threadId",
      params: { threadId: "thread-123" },
    });
  });

  it("ignores settings routes as a back target", () => {
    expect(resolveSettingsBackNavigation("/settings/appearance")).toEqual({ to: "/" });
  });
});
