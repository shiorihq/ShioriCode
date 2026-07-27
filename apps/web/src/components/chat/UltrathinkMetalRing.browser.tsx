import "../../index.css";

import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";

import { UltrathinkMetalRing } from "./UltrathinkMetalRing";

vi.mock("metal-fx", () => ({
  MetalFx: ({ children, paused }: { children: ReactNode; paused?: boolean }) => (
    <div className="mock-metal-fx" data-paused={String(paused)}>
      {children}
    </div>
  ),
}));

describe("UltrathinkMetalRing", () => {
  afterEach(() => {
    document.body.replaceChildren();
    vi.restoreAllMocks();
  });

  it("keeps the shader playing when reduced motion is requested", async () => {
    vi.spyOn(window, "matchMedia").mockImplementation(
      (query) =>
        ({
          matches: query === "(prefers-reduced-motion: reduce)",
          media: query,
          onchange: null,
          addEventListener: vi.fn(),
          removeEventListener: vi.fn(),
          addListener: vi.fn(),
          removeListener: vi.fn(),
          dispatchEvent: vi.fn(),
        }) satisfies MediaQueryList,
    );

    const host = document.createElement("div");
    host.className = "relative h-24 w-96";
    document.body.append(host);
    const screen = await render(<UltrathinkMetalRing borderRadius={20} />, { container: host });

    await vi.waitFor(() => {
      const metalFx = host.querySelector<HTMLElement>(".mock-metal-fx");
      expect(metalFx).not.toBeNull();
      expect(metalFx?.dataset.paused).toBe("false");
    });

    await screen.unmount();
  });
});
