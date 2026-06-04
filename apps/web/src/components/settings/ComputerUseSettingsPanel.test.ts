import { describe, expect, it } from "vitest";

import {
  computerUseAgentVisibilityStatus,
  computerUseProviderToolSurfaceChanged,
  computerUseWindowLabel,
} from "./ComputerUseSettingsPanel";

describe("computerUseWindowLabel", () => {
  it("formats stable Computer Use window indices and bounds", () => {
    expect(
      computerUseWindowLabel(
        {
          index: 2,
          title: "Example Page",
          bounds: { x: 10.4, y: 20.5, width: 800.2, height: 600.8 },
        },
        0,
      ),
    ).toBe("[2] Example Page (800x601 at 10,21)");
  });

  it("falls back to the rendered index and an untitled label", () => {
    expect(computerUseWindowLabel({ title: null, bounds: null }, 1)).toBe("[1] Untitled window");
  });
});

describe("computerUseAgentVisibilityStatus", () => {
  it("makes provider sharing the visible next step after enabling local Computer Use", () => {
    expect(
      computerUseAgentVisibilityStatus({
        enabled: true,
        shareWithProviders: false,
        requireApproval: true,
        approvedAppCount: 1,
        permissionsReady: true,
      }),
    ).toMatchObject({
      title: "Agent turns cannot see Computer Use yet",
      variant: "warning",
    });
  });

  it("explains that an empty approved-app allowlist blocks provider-facing desktop tools", () => {
    expect(
      computerUseAgentVisibilityStatus({
        enabled: true,
        shareWithProviders: true,
        requireApproval: false,
        approvedAppCount: 0,
        permissionsReady: true,
      }).description,
    ).toContain("empty allowlist");
  });

  it("reports full visibility when sharing, permissions, and app approval are ready", () => {
    expect(
      computerUseAgentVisibilityStatus({
        enabled: true,
        shareWithProviders: true,
        requireApproval: false,
        approvedAppCount: 2,
        permissionsReady: true,
      }),
    ).toMatchObject({
      title: "Computer Use is visible to supported agents",
      variant: "success",
    });
  });
});

describe("computerUseProviderToolSurfaceChanged", () => {
  const baseComputerUse = {
    enabled: true,
    requireApproval: true,
    shareWithProviders: false,
    approvedApps: [
      {
        bundleIdentifier: "com.apple.finder",
        name: "Finder",
        approvedAt: "2026-06-04T00:00:00.000Z",
      },
    ],
  };

  it("detects provider-facing Computer Use toggle changes", () => {
    expect(
      computerUseProviderToolSurfaceChanged(baseComputerUse, {
        ...baseComputerUse,
        shareWithProviders: true,
      }),
    ).toBe(true);
  });

  it("detects approved app allowlist changes", () => {
    expect(
      computerUseProviderToolSurfaceChanged(baseComputerUse, {
        ...baseComputerUse,
        approvedApps: [
          ...baseComputerUse.approvedApps,
          {
            bundleIdentifier: "com.apple.Safari",
            name: "Safari",
            approvedAt: "2026-06-04T00:01:00.000Z",
          },
        ],
      }),
    ).toBe(true);
  });

  it("ignores approved app metadata changes that do not affect bundle IDs", () => {
    expect(
      computerUseProviderToolSurfaceChanged(baseComputerUse, {
        ...baseComputerUse,
        approvedApps: [
          {
            bundleIdentifier: "com.apple.finder",
            name: "Finder",
            approvedAt: "2026-06-05T00:00:00.000Z",
          },
        ],
      }),
    ).toBe(false);
  });
});
