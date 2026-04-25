import { describe, expect, it } from "vitest";

import {
  buildAssistantSettingsAppendix,
  buildResponseRenderingAppendix,
} from "./assistantPersonality";

describe("assistant settings appendices", () => {
  it("always includes response rendering guidance for Markdown math", () => {
    const appendix = buildAssistantSettingsAppendix({
      personality: "default",
      generateMemories: false,
    });

    expect(appendix).toBe(buildResponseRenderingAppendix());
    expect(appendix).toContain("KaTeX math support");
    expect(appendix).toContain("`$...$` for inline math");
    expect(appendix).toContain("`$$...$$` for display math");
  });

  it("keeps response rendering guidance before optional overlays", () => {
    const appendix = buildAssistantSettingsAppendix({
      personality: "pragmatic",
      generateMemories: true,
    });

    expect(appendix).toMatch(/^## Response Rendering\n/);
    expect(appendix).toContain("\n\n## Personality Overlay\n");
    expect(appendix).toContain("\n\n## Memories\n");
  });
});
