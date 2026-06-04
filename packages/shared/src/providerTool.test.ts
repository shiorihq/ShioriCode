import { describe, expect, it } from "vitest";

import {
  classifyProviderToolLifecycleItemType,
  classifyProviderToolRequestKind,
  extractStructuredProviderToolData,
  getProviderToolInputActionType,
  getProviderToolInputActionValue,
  getProviderToolInputPath,
  getProviderToolInputQuery,
  isTodoListToolName,
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
      "StrReplaceFile",
    ]) {
      expect(classifyProviderToolLifecycleItemType(toolName)).toBe("file_change");
      expect(classifyProviderToolRequestKind(toolName)).toBe("file-change");
    }
  });

  it("classifies Computer Use action tools separately from shell commands", () => {
    for (const toolName of [
      "computer_permissions",
      "computer_request_permission",
      "computer_open_permission_guide",
      "computer_list_apps",
      "computer_focus_app",
      "computer_screenshot",
      "computer_click",
      "computer_double_click",
      "computer_right_click",
      "computer_move",
      "computer_drag",
      "computer_type",
      "computer_key",
      "computer_scroll",
      "computer_wait",
    ]) {
      expect(classifyProviderToolRequestKind(toolName)).toBe("computer-use");
    }

    expect(providerToolTitle("computer_list_apps")).toBe("Computer app list");
    expect(providerToolTitle("computer_focus_app")).toBe("Computer focus app");
    expect(providerToolTitle("computer_request_permission")).toBe("Computer permission request");
    expect(providerToolTitle("computer_open_permission_guide")).toBe("Computer permission guide");
    expect(providerToolTitle("computer_screenshot")).toBe("Computer screenshot");
    expect(providerToolTitle("computer_double_click")).toBe("Computer double click");
    expect(providerToolTitle("computer_right_click")).toBe("Computer right click");
    expect(providerToolTitle("computer_drag")).toBe("Computer drag");
    expect(providerToolTitle("computer_wait")).toBe("Computer wait");
  });

  it("classifies prefixed MCP Computer Use tools as computer-use requests", () => {
    expect(classifyProviderToolRequestKind("mcp__shiori-computer-use__computer_click")).toBe(
      "computer-use",
    );
    expect(classifyProviderToolRequestKind("mcp_shiori-computer-use_computer_click")).toBe(
      "computer-use",
    );
    expect(classifyProviderToolRequestKind("mcp_shiori-computer-use_computer_permissions")).toBe(
      "computer-use",
    );
    expect(classifyProviderToolRequestKind("mcp__shiori-computer-use__computer_drag")).toBe(
      "computer-use",
    );
    expect(
      classifyProviderToolRequestKind("mcp__shiori-computer-use__computer_open_permission_guide"),
    ).toBe("computer-use");
    expect(classifyProviderToolRequestKind("mcp__shiori-computer-use__computer_wait")).toBe(
      "computer-use",
    );
    expect(classifyProviderToolRequestKind("mcp__shiori-computer-use__computer_double_click")).toBe(
      "computer-use",
    );
    expect(classifyProviderToolRequestKind("mcp__shiori-computer-use__computer_right_click")).toBe(
      "computer-use",
    );
    expect(providerToolTitle("mcp__shiori-computer-use__computer_click")).toBe("Computer click");
    expect(providerToolTitle("mcp__shiori-computer-use__computer_double_click")).toBe(
      "Computer double click",
    );
    expect(providerToolTitle("mcp__shiori-computer-use__computer_right_click")).toBe(
      "Computer right click",
    );
    expect(providerToolTitle("mcp_shiori-computer-use_computer_click")).toBe("Computer click");
    expect(providerToolTitle("mcp__shiori-computer-use__computer_drag")).toBe("Computer drag");
    expect(
      summarizeProviderToolInvocation("mcp__shiori-computer-use__computer_click", {
        x: 12,
        y: 34,
      }),
    ).toBe('Computer click: {"x":12,"y":34}');
    expect(classifyProviderToolRequestKind("mcp__external__search")).toBe("file-read");
  });

  it("classifies provider-native Computer Use aliases across providers", () => {
    for (const toolName of [
      "computer",
      "screenshot",
      "take_screenshot",
      "left_click",
      "mouse_click",
      "double_click",
      "right_click",
      "mouse_move",
      "cursor_position",
      "left_click_drag",
      "type_text",
      "key_press",
      "scroll",
    ]) {
      expect(classifyProviderToolRequestKind(toolName)).toBe("computer-use");
    }

    expect(providerToolTitle("computer")).toBe("Computer use");
    expect(providerToolTitle("screenshot")).toBe("Computer screenshot");
    expect(providerToolTitle("left_click")).toBe("Computer click");
    expect(providerToolTitle("mouse_move")).toBe("Computer move");
    expect(providerToolTitle("left_click_drag")).toBe("Computer drag");
    expect(providerToolTitle("key_press")).toBe("Computer key");
    expect(providerToolTitle("scroll")).toBe("Computer scroll");
  });

  it("classifies MCP Computer Use tools that expose provider-native action names", () => {
    expect(classifyProviderToolRequestKind("mcp__computer-control__screenshot")).toBe(
      "computer-use",
    );
    expect(classifyProviderToolRequestKind("mcp__computer-control__left_click")).toBe(
      "computer-use",
    );
    expect(classifyProviderToolRequestKind("mcp_computer-control_mouse_move")).toBe("computer-use");
    expect(classifyProviderToolRequestKind("mcp_computer-control_key_press")).toBe("computer-use");
    expect(providerToolTitle("mcp__computer-control__left_click")).toBe("Computer click");
    expect(providerToolTitle("mcp_computer-control_mouse_move")).toBe("Computer move");
  });

  it("classifies subagent tool aliases used across providers", () => {
    for (const toolName of [
      "spawn_agent",
      "send_input",
      "wait_agent",
      "close_agent",
      "resumeAgent",
      "wait",
      "Task",
    ]) {
      expect(classifyProviderToolLifecycleItemType(toolName)).toBe("collab_agent_tool_call");
    }
  });

  it("formats wait-style subagent tool summaries consistently", () => {
    expect(providerToolTitle("Agent")).toBe("Subagent task");
    expect(providerToolTitle("wait")).toBe("Wait for subagent");
    expect(
      summarizeProviderToolInvocation("wait", {
        targets: ["agent-1"],
      }),
    ).toBe("Wait for subagent: agent-1");
    expect(
      summarizeProviderToolInvocation("close_agent", {
        target: "agent-2",
      }),
    ).toBe("Close subagent: agent-2");
  });

  it("recognizes Kimi SetTodoList as a todo-list tool", () => {
    expect(isTodoListToolName("SetTodoList")).toBe(true);
    expect(providerToolTitle("SetTodoList")).toBe("Update todo list");
    expect(
      summarizeProviderToolInvocation("SetTodoList", {
        todos: [
          { title: "Investigate re-render on stop response", status: "in_progress" },
          { title: "Implement fix to prevent scroll jump on stop", status: "pending" },
        ],
      }),
    ).toBe("Update todo list: 2 tasks");
  });

  it("extracts notebook paths from structured tool input", () => {
    expect(getProviderToolInputPath({ notebook_path: "/tmp/demo.ipynb" })).toBe("/tmp/demo.ipynb");
    expect(getProviderToolInputPath({ notebookPath: "/tmp/demo-2.ipynb" })).toBe(
      "/tmp/demo-2.ipynb",
    );
  });

  it("formats provider titles and summaries consistently for notebook and write tools", () => {
    expect(providerToolTitle("NotebookEdit")).toBe("Edit notebook");
    expect(providerToolTitle("StrReplaceFile")).toBe("Edit file");
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
