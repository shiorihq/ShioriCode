import { afterEach, describe, expect, it, vi } from "vitest";

import { playFastModeBlitz } from "./fastModeBlitzFx";

function createComposerFrame(focused: boolean): HTMLElement {
  const frame = document.createElement("div");
  frame.dataset.chatComposerFrame = "true";
  if (focused) frame.dataset.chatComposerFocused = "true";
  Object.defineProperty(frame, "clientHeight", { configurable: true, value: 180 });
  document.body.append(frame);
  return frame;
}

describe("playFastModeBlitz", () => {
  afterEach(() => {
    vi.useRealTimers();
    document.body.replaceChildren();
    vi.restoreAllMocks();
  });

  it("targets the focused composer and replaces a running burst", () => {
    const unfocusedFrame = createComposerFrame(false);
    const focusedFrame = createComposerFrame(true);

    playFastModeBlitz(true);

    const firstBurst = [...focusedFrame.querySelectorAll<HTMLElement>(".fast-mode-blitz")];
    expect(firstBurst).toHaveLength(12);
    expect(unfocusedFrame.querySelectorAll(".fast-mode-blitz")).toHaveLength(0);
    expect(firstBurst.every((particle) => particle.textContent === "⚡")).toBe(true);

    playFastModeBlitz(false);

    const secondBurst = [...focusedFrame.querySelectorAll<HTMLElement>(".fast-mode-blitz")];
    expect(secondBurst).toHaveLength(12);
    expect(firstBurst.every((particle) => !particle.isConnected)).toBe(true);
    expect(secondBurst.every((particle) => particle.textContent === "🐌")).toBe(true);

    for (const particle of secondBurst) particle.dispatchEvent(new Event("animationend"));
    expect(focusedFrame.querySelectorAll(".fast-mode-blitz")).toHaveLength(0);
  });

  it("does not allocate particles when reduced motion is requested", () => {
    const frame = createComposerFrame(true);
    vi.spyOn(window, "matchMedia").mockReturnValue({ matches: true } as MediaQueryList);

    playFastModeBlitz(true);

    expect(frame.querySelectorAll(".fast-mode-blitz")).toHaveLength(0);
  });

  it("cancels stale cleanup timers when a burst is replaced", () => {
    vi.useFakeTimers();
    vi.spyOn(Math, "random").mockReturnValue(0);
    const frame = createComposerFrame(true);

    playFastModeBlitz(true);
    playFastModeBlitz(false);
    vi.advanceTimersByTime(1_100);
    playFastModeBlitz(true);

    expect(frame.querySelectorAll(".fast-mode-blitz")).toHaveLength(12);
    vi.runAllTimers();
    expect(frame.querySelectorAll(".fast-mode-blitz")).toHaveLength(0);
  });
});
