import { describe, expect, it } from "vitest";

import { enrichComputerPermissionGuideInput } from "./permissionInput";

describe("permissionInput", () => {
  it("fills missing permission guide host identity from the desktop environment", () => {
    expect(
      enrichComputerPermissionGuideInput(
        { kind: "accessibility" },
        {
          SHIORICODE_COMPUTER_USE_HOST_APP_BUNDLE_PATH: "/Applications/ShioriCode.app",
          SHIORICODE_COMPUTER_USE_HOST_APP_DISPLAY_NAME: "ShioriCode",
        },
      ),
    ).toEqual({
      kind: "accessibility",
      hostAppBundlePath: "/Applications/ShioriCode.app",
      hostAppDisplayName: "ShioriCode",
    });
  });

  it("keeps explicit host identity ahead of environment fallbacks", () => {
    expect(
      enrichComputerPermissionGuideInput(
        {
          kind: "screen-recording",
          hostAppBundlePath: "/Applications/Custom.app",
          hostAppDisplayName: "Custom",
        },
        {
          SHIORICODE_COMPUTER_USE_HOST_APP_BUNDLE_PATH: "/Applications/ShioriCode.app",
          SHIORICODE_COMPUTER_USE_HOST_APP_DISPLAY_NAME: "ShioriCode",
        },
      ),
    ).toEqual({
      kind: "screen-recording",
      hostAppBundlePath: "/Applications/Custom.app",
      hostAppDisplayName: "Custom",
    });
  });
});
