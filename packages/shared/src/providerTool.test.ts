import { describe, expect, it } from "vitest";

import {
  classifyProviderToolLifecycleItemType,
  classifyProviderToolRequestKind,
  extractStructuredProviderToolData,
  getProviderToolInputActionType,
  getProviderToolInputActionValue,
  getProviderToolInputPath,
  getProviderToolInputQuery,
  providerToolTitle,
  summarizeProviderToolInvocation,
} from "./providerTool";

describe("providerTool", () => {
  it("classifies file-change tool aliases used across providers", () => {
    for (const toolName of [
      "write_file",
      "create_file",
      "delete_file",
      "apply_patch",
      "FileWrite",
      "MultiEdit",
      "NotebookEdit",
    ]) {
      expect(classifyProviderToolLifecycleItemType(toolName)).toBe("file_change");
      expect(classifyProviderToolRequestKind(toolName)).toBe("file-change");
    }
  });

  it("extracts notebook paths from structured tool input", () => {
    expect(getProviderToolInputPath({ notebook_path: "/tmp/demo.ipynb" })).toBe("/tmp/demo.ipynb");
    expect(getProviderToolInputPath({ notebookPath: "/tmp/demo-2.ipynb" })).toBe(
      "/tmp/demo-2.ipynb",
    );
  });

  it("formats provider titles and summaries consistently for notebook and write tools", () => {
    expect(providerToolTitle("NotebookEdit")).toBe("Edit notebook");
    expect(providerToolTitle("FileWrite")).toBe("Write file");
    expect(
      summarizeProviderToolInvocation("NotebookEdit", {
        notebook_path: "/tmp/demo.ipynb",
        new_source: "print('hello')",
      }),
    ).toBe("Edit notebook: /tmp/demo.ipynb");
    expect(
      summarizeProviderToolInvocation("write_file", {
        file_path: "/tmp/demo.ts",
        content: "console.log('hello');",
      }),
    ).toBe("Write file: /tmp/demo.ts");
  });

  it("extracts Codex webSearch thread items into structured tool data", () => {
    const toolData = extractStructuredProviderToolData({
      type: "webSearch",
      id: "ws_123",
      query: "latest python features",
      action: {
        type: "search",
        value: "latest python features",
      },
    });

    expect(toolData).toEqual({
      toolName: "webSearch",
      input: {
        query: "latest python features",
        action: {
          type: "search",
          value: "latest python features",
        },
        action_type: "search",
        action_value: "latest python features",
      },
      item: {
        type: "webSearch",
        id: "ws_123",
        query: "latest python features",
        action: {
          type: "search",
          value: "latest python features",
        },
      },
    });
    expect(getProviderToolInputQuery(toolData?.input ?? null)).toBe("latest python features");
    expect(getProviderToolInputActionType(toolData?.input ?? null)).toBe("search");
    expect(getProviderToolInputActionValue(toolData?.input ?? null)).toBe("latest python features");
  });

  it("summarizes Codex webSearch open_page items using the page target", () => {
    expect(
      summarizeProviderToolInvocation("webSearch", {
        action: {
          type: "open_page",
          value: "https://developers.openai.com/codex/sdk/",
        },
      }),
    ).toBe("Web Search: https://developers.openai.com/codex/sdk/");
  });
});
