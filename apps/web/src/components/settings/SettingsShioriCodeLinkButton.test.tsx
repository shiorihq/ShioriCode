import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import { SettingsShioriCodeLinkButton } from "./SettingsShioriCodeLinkButton";

describe("SettingsShioriCodeLinkButton", () => {
  it("renders the branded Link destination", () => {
    const html = renderToStaticMarkup(<SettingsShioriCodeLinkButton onClick={vi.fn()} />);

    expect(html).toContain("ShioriCode Link");
    expect(html).toContain('src="/app-logo.png"');
    expect(html).toContain("data-shioricode-link-logo");
  });
});
