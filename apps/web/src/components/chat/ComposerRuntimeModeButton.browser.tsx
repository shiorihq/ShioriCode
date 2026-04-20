import "../../index.css";

import { page } from "vitest/browser";
import { afterEach, describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";

import { ComposerRuntimeModeButton } from "./ComposerRuntimeModeButton";

async function mountRuntimeModeButton(props: {
  compact: boolean;
  runtimeMode: "approval-required" | "full-access";
}) {
  const host = document.createElement("div");
  document.body.append(host);
  const onToggle = vi.fn();
  const screen = await render(
    <ComposerRuntimeModeButton
      compact={props.compact}
      runtimeMode={props.runtimeMode}
      onToggle={onToggle}
    />,
    { container: host },
  );

  const cleanup = async () => {
    await screen.unmount();
    host.remove();
  };

  return {
    [Symbol.asyncDispose]: cleanup,
    cleanup,
    onToggle,
  };
}

describe("ComposerRuntimeModeButton", () => {
  afterEach(() => {
    document.body.innerHTML = "";
  });

  it.skip("shows supervised as a closed lock in compact composers", async () => {
    await using mounted = await mountRuntimeModeButton({
      compact: true,
      runtimeMode: "approval-required",
    });

    const button = page.getByRole("button", { name: "Supervised — click for full access" });

    await expect.element(button).toHaveAttribute("title", "Supervised — click for full access");
    await expect.element(button).toContain("Supervised");
    expect(document.querySelector("button span")?.className).not.toContain("sr-only");
    expect(document.querySelector("button svg")).not.toBeNull();

    await button.click();
    expect(mounted.onToggle).toHaveBeenCalledTimes(1);
  });

  it.skip("shows full access as an open lock in compact composers", async () => {
    await using _ = await mountRuntimeModeButton({
      compact: true,
      runtimeMode: "full-access",
    });

    const button = page.getByRole("button", { name: "Full access — click to require approvals" });

    await expect
      .element(button)
      .toHaveAttribute("title", "Full access — click to require approvals");
    await expect.element(button).toContain("Full access");
    expect(document.querySelector("button span")?.className).not.toContain("sr-only");
    expect(document.querySelector("button svg")).not.toBeNull();
  });
});
