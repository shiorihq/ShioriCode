import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { AssistantSelectionAddToChatControl } from "./AssistantSelectionAddToChatButton";

describe("AssistantSelectionAddToChatControl", () => {
  it("uses an opaque surface so selected text does not show through on hover", () => {
    const markup = renderToStaticMarkup(
      <AssistantSelectionAddToChatControl onPointerDown={() => {}} onClick={() => {}} />,
    );

    expect(markup).toContain("bg-popover");
    expect(markup).toContain("hover:bg-accent");
    expect(markup).not.toContain("bg-popover/95");
    expect(markup).not.toContain("backdrop-blur");
    expect(markup).not.toContain("hover:bg-foreground/10");
  });
});
