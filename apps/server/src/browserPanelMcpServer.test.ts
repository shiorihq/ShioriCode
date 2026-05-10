import assert from "node:assert/strict";
import { afterEach, describe, expect, it, vi } from "vitest";

import { browserPanelCommandForTool, runBrowserCommand } from "./browserPanelMcpServer.ts";

const ORIGINAL_ENV = { ...process.env };

afterEach(() => {
  process.env.SHIORICODE_BROWSER_CONTROL_URL = ORIGINAL_ENV.SHIORICODE_BROWSER_CONTROL_URL;
  process.env.SHIORICODE_BROWSER_THREAD_ID = ORIGINAL_ENV.SHIORICODE_BROWSER_THREAD_ID;
  process.env.SHIORICODE_BROWSER_CONTROL_TOKEN = ORIGINAL_ENV.SHIORICODE_BROWSER_CONTROL_TOKEN;
  vi.restoreAllMocks();
});

describe("browserPanelCommandForTool", () => {
  it("normalizes navigation URLs and localhost targets", () => {
    expect(browserPanelCommandForTool("browser_navigate", { url: "example.com" })).toEqual({
      type: "navigate",
      url: "https://example.com",
    });
    expect(browserPanelCommandForTool("browser_navigate", { url: "localhost:5173" })).toEqual({
      type: "navigate",
      url: "http://localhost:5173",
    });
    expect(
      browserPanelCommandForTool("browser_navigate", { url: "file:///tmp/index.html" }),
    ).toEqual({
      type: "navigate",
      url: "file:///tmp/index.html",
    });
  });

  it("maps JavaScript, snapshot, history, and selector tools to browser commands", () => {
    expect(
      browserPanelCommandForTool("browser_evaluate_javascript", {
        script: "document.title",
      }),
    ).toEqual({
      type: "evaluate",
      script: "document.title",
      awaitPromise: true,
    });
    expect(
      browserPanelCommandForTool("browser_evaluate_javascript", {
        script: "Promise.resolve(1)",
        awaitPromise: false,
      }),
    ).toEqual({
      type: "evaluate",
      script: "Promise.resolve(1)",
      awaitPromise: false,
    });
    expect(browserPanelCommandForTool("browser_snapshot", { includeText: false })).toEqual({
      type: "snapshot",
      includeText: false,
      includeLinks: true,
      includeForms: true,
      includeElements: true,
      maxElements: 80,
    });
    expect(browserPanelCommandForTool("browser_go_back", {})).toEqual({
      type: "action",
      action: "back",
    });
    expect(browserPanelCommandForTool("browser_go_forward", {})).toEqual({
      type: "action",
      action: "forward",
    });
    expect(browserPanelCommandForTool("browser_reload", {})).toEqual({
      type: "action",
      action: "reload",
    });
    expect(browserPanelCommandForTool("browser_stop", {})).toEqual({
      type: "action",
      action: "stop",
    });
    expect(browserPanelCommandForTool("browser_click_selector", { selector: "#save" })).toEqual({
      type: "click-selector",
      selector: "#save",
    });
    expect(browserPanelCommandForTool("browser_hover_selector", { selector: "#save" })).toEqual({
      type: "hover-selector",
      selector: "#save",
    });
    expect(
      browserPanelCommandForTool("browser_type_selector", {
        selector: "input[name=q]",
        text: "hello",
      }),
    ).toEqual({
      type: "type-selector",
      selector: "input[name=q]",
      text: "hello",
    });
    expect(
      browserPanelCommandForTool("browser_fill_selector", {
        selector: "input[name=q]",
        text: "hello",
      }),
    ).toEqual({
      type: "fill-selector",
      selector: "input[name=q]",
      text: "hello",
    });
    expect(
      browserPanelCommandForTool("browser_select_selector", {
        selector: "select[name=sort]",
        value: "recent",
      }),
    ).toEqual({
      type: "select-selector",
      selector: "select[name=sort]",
      value: "recent",
    });
    expect(browserPanelCommandForTool("browser_wait_for", { text: "Ready" })).toEqual({
      type: "wait",
      text: "Ready",
      timeoutMs: 5000,
    });
    expect(browserPanelCommandForTool("browser_press_key", { key: "Enter" })).toEqual({
      type: "press-key",
      key: "Enter",
    });
    expect(browserPanelCommandForTool("browser_scroll", { deltaY: -300 })).toEqual({
      type: "scroll",
      deltaX: 0,
      deltaY: -300,
    });
    expect(browserPanelCommandForTool("browser_console_messages", { clear: true })).toEqual({
      type: "console",
      clear: true,
    });
  });

  it("rejects missing required arguments before making a control request", () => {
    assert.throws(() => browserPanelCommandForTool("browser_navigate", {}), /url is required/);
    assert.throws(
      () => browserPanelCommandForTool("browser_evaluate_javascript", { script: " " }),
      /script is required/,
    );
    assert.throws(
      () => browserPanelCommandForTool("browser_click_selector", {}),
      /selector is required/,
    );
    assert.throws(
      () => browserPanelCommandForTool("browser_type_selector", { selector: "#q" }),
      /text is required/,
    );
    assert.throws(() => browserPanelCommandForTool("browser_wait_for", {}), /selector or text/);
    assert.throws(() => browserPanelCommandForTool("browser_press_key", {}), /key is required/);
  });
});

describe("runBrowserCommand", () => {
  it("posts commands to the configured command endpoint with auth and returns MCP text content", async () => {
    process.env.SHIORICODE_BROWSER_CONTROL_URL = "http://127.0.0.1:4321/api/browser-panel/command";
    process.env.SHIORICODE_BROWSER_THREAD_ID = "thread-browser";
    process.env.SHIORICODE_BROWSER_CONTROL_TOKEN = "secret-token";
    const fetchMock = vi.fn(async () => ({
      ok: true,
      json: async () => ({
        result: {
          ok: true,
          value: { title: "Example" },
        },
      }),
    }));
    vi.stubGlobal("fetch", fetchMock);

    const result = await runBrowserCommand("browser_evaluate_javascript", {
      script: "document.title",
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("http://127.0.0.1:4321/api/browser-panel/command");
    expect(init.headers).toMatchObject({
      "Content-Type": "application/json",
      Authorization: "Bearer secret-token",
    });
    expect(JSON.parse(String(init.body))).toMatchObject({
      threadId: "thread-browser",
      type: "evaluate",
      script: "document.title",
      awaitPromise: true,
    });
    expect(result).toEqual({
      content: [
        {
          type: "text",
          text: JSON.stringify({ title: "Example" }, null, 2),
        },
      ],
    });
  });

  it("surfaces command failures from the browser panel", async () => {
    process.env.SHIORICODE_BROWSER_CONTROL_URL = "http://127.0.0.1:4321/api/browser-panel/command";
    process.env.SHIORICODE_BROWSER_THREAD_ID = "thread-browser";
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: true,
        json: async () => ({
          result: { ok: false, error: "No element matched selector: #missing" },
        }),
      })),
    );

    await expect(
      runBrowserCommand("browser_click_selector", { selector: "#missing" }),
    ).rejects.toThrow("No element matched selector: #missing");
  });
});
