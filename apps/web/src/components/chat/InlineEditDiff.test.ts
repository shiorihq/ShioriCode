import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { InlineEditDiff, parseEditDiff } from "./InlineEditDiff";

describe("parseEditDiff", () => {
  it("parses Claude Edit old/new strings even when result is present", () => {
    const parsed = parseEditDiff({
      toolName: "Edit",
      input: {
        file_path:
          "/Users/choki/Developer/shiori-code/apps/web/src/components/chat/MessagesTimeline.tsx",
        old_string: "<span>{completionSummary}\\n",
        new_string: "<span>{completionSummary}",
      },
      result: {
        type: "tool_result",
        tool_use_id: "toolu_01FGFvvGvT1N6hJwsW",
        content: "The file was updated.",
      },
    });

    expect(parsed).not.toBeNull();
    expect(parsed?.filePath).toBe(
      "/Users/choki/Developer/shiori-code/apps/web/src/components/chat/MessagesTimeline.tsx",
    );
    expect(parsed?.additions).toBe(1);
    expect(parsed?.deletions).toBe(1);
    expect(parsed?.lines).toEqual([
      { type: "removed", content: "<span>{completionSummary}\\n", oldLineNo: 1, newLineNo: null },
      { type: "added", content: "<span>{completionSummary}", oldLineNo: null, newLineNo: 1 },
    ]);
  });

  it("parses write_file tool payloads using input.content when completion output is bytes-only", () => {
    const parsed = parseEditDiff({
      toolName: "write_file",
      input: {
        path: "apps/web/src/index.css",
        content: "body {\n  color: red;\n}",
      },
      path: "apps/web/src/index.css",
      bytesWritten: 22,
    });

    expect(parsed).not.toBeNull();
    expect(parsed?.filePath).toBe("apps/web/src/index.css");
    expect(parsed?.additions).toBe(3);
    expect(parsed?.deletions).toBe(1);
    expect(parsed?.lines).toEqual([
      { type: "removed", content: "", oldLineNo: 1, newLineNo: null },
      { type: "added", content: "body {", oldLineNo: null, newLineNo: 1 },
      { type: "added", content: "  color: red;", oldLineNo: null, newLineNo: 2 },
      { type: "added", content: "}", oldLineNo: null, newLineNo: 3 },
    ]);
  });

  it("renders the inline diff with an internal scroll region", () => {
    const parsed = parseEditDiff({
      toolName: "write_file",
      input: {
        path: "apps/web/src/index.css",
        content: "body {\n  color: red;\n}",
      },
      path: "apps/web/src/index.css",
      bytesWritten: 22,
    });

    expect(parsed).not.toBeNull();

    const markup = renderToStaticMarkup(createElement(InlineEditDiff, { diff: parsed! }));

    expect(markup).toContain('data-inline-diff="true"');
    expect(markup).toContain('data-inline-diff-body="true"');
    expect(markup).toContain("max-h-[min(24rem,55vh)]");
    expect(markup).toContain("overflow-auto");
  });
});
