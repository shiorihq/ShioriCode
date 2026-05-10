import { describe, expect, it, vi } from "vitest";

import type { BrowserPanelCommand } from "contracts";
import type { BrowserWebviewElement } from "./browserWebviewStore";
import {
  clickSelectorScript,
  fillSelectorScript,
  hoverSelectorScript,
  scrollScript,
  selectSelectorScript,
  runBrowserPanelCommandOnWebview,
  snapshotScript,
  typeSelectorScript,
  waitScript,
} from "./browserPanelCommandRunner";

type FakeWebviewOverrides = Partial<
  Omit<BrowserWebviewElement, "loadURL" | "executeJavaScript">
> & {
  loadURL?: BrowserWebviewElement["loadURL"] | undefined;
  executeJavaScript?: BrowserWebviewElement["executeJavaScript"] | undefined;
};

function makeWebview(overrides: FakeWebviewOverrides = {}): BrowserWebviewElement & {
  loadURL: ReturnType<typeof vi.fn>;
  executeJavaScript: ReturnType<typeof vi.fn>;
  goBack: ReturnType<typeof vi.fn>;
  goForward: ReturnType<typeof vi.fn>;
  reload: ReturnType<typeof vi.fn>;
  stop: ReturnType<typeof vi.fn>;
  sendInputEvent: ReturnType<typeof vi.fn>;
} {
  const attributes = new Map<string, string>();
  return {
    style: {} as CSSStyleDeclaration,
    setAttribute: vi.fn((name: string, value: string) => {
      attributes.set(name, value);
    }),
    getAttribute: vi.fn((name: string) => attributes.get(name) ?? null),
    getURL: vi.fn(() => "https://example.com/current"),
    getTitle: vi.fn(() => "Example"),
    isLoading: vi.fn(() => false),
    canGoBack: vi.fn(() => true),
    canGoForward: vi.fn(() => false),
    loadURL: vi.fn(async () => undefined),
    executeJavaScript: vi.fn(async () => ({ ok: true })),
    goBack: vi.fn(),
    goForward: vi.fn(),
    reload: vi.fn(),
    stop: vi.fn(),
    sendInputEvent: vi.fn(),
    ...overrides,
  } as never;
}

describe("runBrowserPanelCommandOnWebview", () => {
  it("loads normalized navigation URLs and returns the browser snapshot", async () => {
    const webview = makeWebview();

    const result = await runBrowserPanelCommandOnWebview(
      {
        id: "cmd-1",
        threadId: "thread-1",
        type: "navigate",
        url: "example.com/path",
      } as BrowserPanelCommand,
      webview,
    );

    expect(webview.loadURL).toHaveBeenCalledWith("https://example.com/path");
    expect(result).toMatchObject({
      ok: true,
      address: "https://example.com/path",
      value: {
        title: "Example",
        url: "https://example.com/current",
        canGoBack: true,
        canGoForward: false,
      },
    });
  });

  it("uses setAttribute when loadURL is unavailable", async () => {
    const webview = makeWebview({ loadURL: undefined });

    const result = await runBrowserPanelCommandOnWebview(
      {
        id: "cmd-2",
        threadId: "thread-1",
        type: "navigate",
        url: "localhost:3000",
      } as BrowserPanelCommand,
      webview,
    );

    expect(webview.setAttribute).toHaveBeenCalledWith("src", "http://localhost:3000");
    expect(result.ok).toBe(true);
  });

  it("runs history and loading actions", async () => {
    const webview = makeWebview();
    for (const [action, spy] of [
      ["back", webview.goBack],
      ["forward", webview.goForward],
      ["reload", webview.reload],
      ["stop", webview.stop],
    ] as const) {
      const result = await runBrowserPanelCommandOnWebview(
        {
          id: `cmd-${action}`,
          threadId: "thread-1",
          type: "action",
          action,
        } as BrowserPanelCommand,
        webview,
      );
      expect(result.ok).toBe(true);
      expect(spy).toHaveBeenCalledTimes(1);
    }
  });

  it("executes JavaScript and propagates JavaScript failures", async () => {
    const webview = makeWebview({ executeJavaScript: vi.fn(async () => 42) });
    await expect(
      runBrowserPanelCommandOnWebview(
        {
          id: "cmd-js",
          threadId: "thread-1",
          type: "evaluate",
          script: "21 * 2",
        } as BrowserPanelCommand,
        webview,
      ),
    ).resolves.toEqual({ ok: true, value: 42 });
    expect(webview.executeJavaScript).toHaveBeenCalledWith("21 * 2", true);

    const failing = makeWebview({
      executeJavaScript: vi.fn(async () => {
        throw new Error("boom");
      }),
    });
    await expect(
      runBrowserPanelCommandOnWebview(
        {
          id: "cmd-fail",
          threadId: "thread-1",
          type: "evaluate",
          script: "throw new Error('boom')",
        } as BrowserPanelCommand,
        failing,
      ),
    ).resolves.toEqual({ ok: false, error: "boom" });
  });

  it("builds snapshot and selector scripts for executeJavaScript", async () => {
    const webview = makeWebview({ executeJavaScript: vi.fn(async () => ({ done: true })) });
    const snapshotCommand = {
      id: "cmd-snapshot",
      threadId: "thread-1",
      type: "snapshot",
      includeText: false,
      includeLinks: true,
      includeForms: false,
    } as Extract<BrowserPanelCommand, { type: "snapshot" }>;

    const snapshot = await runBrowserPanelCommandOnWebview(snapshotCommand, webview);
    expect(snapshot.ok).toBe(true);
    expect(webview.executeJavaScript).toHaveBeenLastCalledWith(
      snapshotScript(snapshotCommand),
      true,
    );

    await runBrowserPanelCommandOnWebview(
      {
        id: "cmd-click",
        threadId: "thread-1",
        type: "click-selector",
        selector: "#save",
      } as BrowserPanelCommand,
      webview,
    );
    expect(webview.executeJavaScript).toHaveBeenLastCalledWith(clickSelectorScript("#save"), true);

    await runBrowserPanelCommandOnWebview(
      {
        id: "cmd-type",
        threadId: "thread-1",
        type: "type-selector",
        selector: "input[name=q]",
        text: "hello",
      } as BrowserPanelCommand,
      webview,
    );
    expect(webview.executeJavaScript).toHaveBeenLastCalledWith(
      typeSelectorScript("input[name=q]", "hello"),
      true,
    );

    await runBrowserPanelCommandOnWebview(
      {
        id: "cmd-hover",
        threadId: "thread-1",
        type: "hover-selector",
        selector: "#save",
      } as BrowserPanelCommand,
      webview,
    );
    expect(webview.executeJavaScript).toHaveBeenLastCalledWith(hoverSelectorScript("#save"), true);

    await runBrowserPanelCommandOnWebview(
      {
        id: "cmd-fill",
        threadId: "thread-1",
        type: "fill-selector",
        selector: "input[name=q]",
        text: "replacement",
      } as BrowserPanelCommand,
      webview,
    );
    expect(webview.executeJavaScript).toHaveBeenLastCalledWith(
      fillSelectorScript("input[name=q]", "replacement"),
      true,
    );

    await runBrowserPanelCommandOnWebview(
      {
        id: "cmd-select",
        threadId: "thread-1",
        type: "select-selector",
        selector: "select[name=sort]",
        value: "recent",
      } as BrowserPanelCommand,
      webview,
    );
    expect(webview.executeJavaScript).toHaveBeenLastCalledWith(
      selectSelectorScript("select[name=sort]", "recent"),
      true,
    );

    const waitCommand = {
      id: "cmd-wait",
      threadId: "thread-1",
      type: "wait",
      selector: "#ready",
      timeoutMs: 250,
    } as Extract<BrowserPanelCommand, { type: "wait" }>;
    await runBrowserPanelCommandOnWebview(waitCommand, webview);
    expect(webview.executeJavaScript).toHaveBeenLastCalledWith(waitScript(waitCommand), true);

    const scrollCommand = {
      id: "cmd-scroll",
      threadId: "thread-1",
      type: "scroll",
      deltaY: 500,
    } as Extract<BrowserPanelCommand, { type: "scroll" }>;
    await runBrowserPanelCommandOnWebview(scrollCommand, webview);
    expect(webview.executeJavaScript).toHaveBeenLastCalledWith(scrollScript(scrollCommand), true);
  });

  it("sends keyboard input through Electron when available", async () => {
    const webview = makeWebview();

    const result = await runBrowserPanelCommandOnWebview(
      {
        id: "cmd-key",
        threadId: "thread-1",
        type: "press-key",
        key: "Mod+L",
      } as BrowserPanelCommand,
      webview,
    );

    expect(result).toEqual({ ok: true, value: { pressed: true, key: "Mod+L" } });
    expect(webview.sendInputEvent).toHaveBeenCalledWith(
      expect.objectContaining({ type: "keyDown", keyCode: "L" }),
    );
    expect(webview.sendInputEvent).toHaveBeenCalledWith(
      expect.objectContaining({ type: "keyUp", keyCode: "L" }),
    );
    expect(webview.executeJavaScript).not.toHaveBeenCalled();
  });

  it("returns captured console messages and can clear them", async () => {
    const webview = makeWebview();
    const clearConsoleEntries = vi.fn();
    const result = await runBrowserPanelCommandOnWebview(
      {
        id: "cmd-console",
        threadId: "thread-1",
        type: "console",
        clear: true,
      } as BrowserPanelCommand,
      webview,
      {
        consoleEntries: [
          {
            level: "error",
            message: "boom",
            sourceId: "app.js",
            line: 12,
            timestamp: 1,
          },
        ],
        clearConsoleEntries,
      },
    );

    expect(result).toEqual({
      ok: true,
      value: {
        messages: [
          {
            level: "error",
            message: "boom",
            sourceId: "app.js",
            line: 12,
            timestamp: 1,
          },
        ],
      },
    });
    expect(clearConsoleEntries).toHaveBeenCalledTimes(1);
  });

  it("fails JS-backed commands when executeJavaScript is unavailable", async () => {
    const webview = makeWebview({ executeJavaScript: undefined });
    const result = await runBrowserPanelCommandOnWebview(
      {
        id: "cmd-js-unavailable",
        threadId: "thread-1",
        type: "evaluate",
        script: "document.title",
      } as BrowserPanelCommand,
      webview,
    );

    expect(result).toEqual({
      ok: false,
      error: "This Browser panel cannot execute JavaScript yet.",
    });
  });
});
