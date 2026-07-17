import "../../index.css";

import { page } from "vitest/browser";
import { describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";

vi.mock("~/hooks/useDesktopRemoteConnection", () => ({
  LOCAL_DESKTOP_CONNECTION_VALUE: "__local__",
  desktopRemoteLabel: (value: string) => value,
  useDesktopRemoteConnection: () => ({
    busy: false,
    connect: vi.fn(),
    connection: {
      mode: "local",
      remoteUrl: null,
      savedRemoteUrls: ["remote.example.com"],
    },
    error: null,
    label: "This computer",
    loading: false,
    supported: true,
    useLocal: vi.fn(),
  }),
}));

import { SidebarRemoteSwitcher } from "./SidebarRemoteSwitcher";

describe("SidebarRemoteSwitcher", () => {
  it("opens the grouped connection menu without a Base UI context error", async () => {
    await render(<SidebarRemoteSwitcher onManage={vi.fn()} />);

    await page.getByRole("button", { name: "Connected to This computer" }).click();

    await expect.element(page.getByText("Run ShioriCode on")).toBeVisible();
    await expect.element(page.getByRole("menuitemradio", { name: "This computer" })).toBeVisible();
    await expect
      .element(page.getByRole("menuitem", { name: "Add or manage remotes…" }))
      .toBeVisible();
  });
});
