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

  it("adds file-type icons to markdown file links", () => {
    const html = renderToStaticMarkup(
      <ChatMarkdown
        cwd="/Users/choki/Developer/shiori-code"
        text={"Changed [ChatMarkdown.tsx](apps/web/src/components/ChatMarkdown.tsx#L54)."}
      />,
    );

    expect(html).toContain("app-file-href-link");
    expect(html).toContain("app-file-href-icon");
    expect(html).toContain("file_type_reactts.svg");
    expect(html).toContain("ChatMarkdown.tsx");
  });

  it("leaves external markdown links text-only", () => {
    const html = renderToStaticMarkup(
      <ChatMarkdown
        cwd="/Users/choki/Developer/shiori-code"
        text={"Visit [OpenAI](https://openai.com)."}
      />,
    );

    expect(html).not.toContain("app-file-href-link");
    expect(html).not.toContain("app-file-href-icon");
  });
});
