import "../../index.css";

import { page } from "vitest/browser";
import { describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";
import { useState } from "react";

import { EffortSliderPanel } from "./EffortSlider";

function Harness(props: { onCommit: (value: string) => void }) {
  const [value, setValue] = useState("high");
  return (
    <div style={{ width: 320, padding: 24 }}>
      <EffortSliderPanel
        levels={[
          { value: "low", label: "Low" },
          { value: "medium", label: "Medium" },
          { value: "high", label: "High", isDefault: true },
          { value: "max", label: "Max" },
        ]}
        value={value}
        onChange={(next) => {
          props.onCommit(next);
          setValue(next);
        }}
      />
      <output data-testid="value">{value}</output>
    </div>
  );
}

describe("debug slider drag", () => {
  it("commits the dragged level on release", async () => {
    const onCommit = vi.fn();
    const host = document.createElement("div");
    document.body.append(host);
    await render(<Harness onCommit={onCommit} />, { container: host });

    const track = document.querySelector<HTMLElement>('[data-chat-effort-slider="true"]');
    if (!track) throw new Error("track not found");
    const rect = track.getBoundingClientRect();
    const y = rect.top + rect.height / 2;
    const startX = rect.left + rect.width * 0.65; // "high" zone
    const endX = rect.left + rect.width * 0.1; // "low" zone

    function firePointer(type: string, x: number, target: Element) {
      target.dispatchEvent(
        new PointerEvent(type, {
          bubbles: true,
          cancelable: true,
          composed: true,
          pointerId: 1,
          pointerType: "mouse",
          isPrimary: true,
          button: type === "pointerdown" ? 0 : type === "pointerup" ? 0 : -1,
          buttons: type === "pointerup" ? 0 : 1,
          clientX: x,
          clientY: y,
        }),
      );
    }

    const startTarget = document.elementFromPoint(startX, y) ?? track;
    firePointer("pointerdown", startX, startTarget);
    firePointer("pointermove", startX - 30, track);
    await new Promise((resolve) => setTimeout(resolve, 30));
    firePointer("pointermove", endX, track);
    await new Promise((resolve) => setTimeout(resolve, 30));
    firePointer("pointerup", endX, track);

    await vi.waitFor(() => {
      expect(onCommit).toHaveBeenCalledWith("low");
    });
    await expect.element(page.getByTestId("value")).toHaveTextContent("low");
  });
});
