import "../../index.css";

import { useRef } from "react";
import { page } from "vitest/browser";
import { afterEach, describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";

import { AssistantSelectionAddToChatButton } from "./AssistantSelectionAddToChatButton";

function SelectionOverlayFixture({
  onAddSelectedText = vi.fn(),
}: {
  onAddSelectedText?: (selectedText: string) => void;
}) {
  const containerRef = useRef<HTMLDivElement | null>(null);

  return (
    <div ref={containerRef}>
      <p className="assistant-text-selectable">Selected assistant text for follow up</p>
      <AssistantSelectionAddToChatButton
        containerRef={containerRef}
        onAddSelectedText={onAddSelectedText}
      />
    </div>
  );
}

async function selectAssistantText() {
  const target = document.querySelector(".assistant-text-selectable");
  const textNode = target?.firstChild;
  if (!target || !textNode) {
    throw new Error("Expected assistant text fixture to render.");
  }

  const range = document.createRange();
  range.setStart(textNode, 0);
  range.setEnd(textNode, "Selected".length);
  const selection = window.getSelection();
  selection?.removeAllRanges();
  selection?.addRange(range);
  document.dispatchEvent(new Event("selectionchange"));
  document.dispatchEvent(new PointerEvent("pointerup"));
}

describe("AssistantSelectionAddToChatButton", () => {
  afterEach(() => {
    window.getSelection()?.removeAllRanges();
    document.body.innerHTML = "";
  });

  it("keeps the native text selection while showing the action", async () => {
    const onAddSelectedText = vi.fn();
    const screen = await render(<SelectionOverlayFixture onAddSelectedText={onAddSelectedText} />);

    try {
      await vi.waitFor(() => {
        expect(document.querySelector(".assistant-text-selectable")).not.toBeNull();
      });
      await new Promise<void>((resolve) => window.requestAnimationFrame(() => resolve()));
      await selectAssistantText();
      expect(window.getSelection()?.toString()).toBe("Selected");

      await expect.element(page.getByRole("button", { name: "Add to chat" })).toBeVisible();
      await new Promise<void>((resolve) => window.requestAnimationFrame(() => resolve()));
      expect(window.getSelection()?.toString()).toBe("Selected");

      await page.getByRole("button", { name: "Add to chat" }).click();
      expect(onAddSelectedText).toHaveBeenCalledWith("Selected");
    } finally {
      await screen.unmount();
    }
  });
});
