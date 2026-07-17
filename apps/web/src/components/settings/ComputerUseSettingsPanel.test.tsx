import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("../../hooks/useSettings", () => ({
  useSettings: () => ({ computerUse: { enabled: true } }),
  useUpdateSettings: () => ({ updateSettings: vi.fn() }),
}));

vi.mock("../../nativeApi", () => ({
  readNativeApi: () => undefined,
}));

import { ComputerUseSettingsPanel } from "./ComputerUseSettingsPanel";

describe("ComputerUseSettingsPanel", () => {
  it("only shows the Computer Use switch", () => {
    const html = renderToStaticMarkup(<ComputerUseSettingsPanel />);

    expect(html).toContain('aria-label="Enable Computer Use"');
    expect(html).toContain("Allow agents to see and control this Mac");
    expect(html).not.toContain("Live desktop preview");
    expect(html).not.toContain("Permission checklist");
    expect(html).not.toContain("Local desktop boundary");
    expect(html).not.toContain("macOS Permissions");
  });
});
