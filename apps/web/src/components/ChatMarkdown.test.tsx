import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import ChatMarkdown from "./ChatMarkdown";

vi.mock("../hooks/useTheme", () => ({
  useTheme: () => ({ resolvedTheme: "dark" }),
}));

describe("ChatMarkdown", () => {
  it("renders inline and block LaTeX with KaTeX", () => {
    const html = renderToStaticMarkup(
      <ChatMarkdown cwd={undefined} text={"Euler: $e^{i\\pi}+1=0$\n\n$$\n\\int_0^1 x^2 dx\n$$"} />,
    );

    expect(html).toContain('class="katex"');
    expect(html).toContain('class="katex-display"');
    expect(html).toContain("e^{i\\pi}+1=0");
  });
});
