import { Schema } from "effect";
import { describe, expect, it } from "vitest";

import { BrowserPanelCommand, BrowserPanelCommandResult } from "./browser";

const decodeCommand = Schema.decodeUnknownSync(BrowserPanelCommand);
const decodeResult = Schema.decodeUnknownSync(BrowserPanelCommandResult);

describe("BrowserPanelCommand", () => {
  it("accepts all supported browser command variants", () => {
    expect(
      decodeCommand({
        id: "cmd-1",
        threadId: "thread-1",
        type: "navigate",
        url: "https://example.com",
      }),
    ).toMatchObject({ type: "navigate" });
    expect(
      decodeCommand({
        id: "cmd-2",
        threadId: "thread-1",
        type: "evaluate",
        script: "document.title",
        awaitPromise: true,
      }),
    ).toMatchObject({ type: "evaluate" });
    expect(
      decodeCommand({
        id: "cmd-3",
        threadId: "thread-1",
        type: "snapshot",
        includeText: false,
        includeLinks: true,
        includeForms: true,
        includeElements: true,
        maxElements: 40,
      }),
    ).toMatchObject({ type: "snapshot" });
    expect(
      decodeCommand({
        id: "cmd-4",
        threadId: "thread-1",
        type: "action",
        action: "reload",
      }),
    ).toMatchObject({ type: "action" });
    expect(
      decodeCommand({
        id: "cmd-5",
        threadId: "thread-1",
        type: "click-selector",
        selector: "#submit",
      }),
    ).toMatchObject({ type: "click-selector" });
    expect(
      decodeCommand({
        id: "cmd-6",
        threadId: "thread-1",
        type: "type-selector",
        selector: "input[name=q]",
        text: "search text",
      }),
    ).toMatchObject({ type: "type-selector" });
    expect(
      decodeCommand({
        id: "cmd-7",
        threadId: "thread-1",
        type: "hover-selector",
        selector: "button",
      }),
    ).toMatchObject({ type: "hover-selector" });
    expect(
      decodeCommand({
        id: "cmd-8",
        threadId: "thread-1",
        type: "select-selector",
        selector: "select[name=sort]",
        value: "recent",
      }),
    ).toMatchObject({ type: "select-selector" });
    expect(
      decodeCommand({
        id: "cmd-9",
        threadId: "thread-1",
        type: "wait",
        selector: "#ready",
        timeoutMs: 2500,
      }),
    ).toMatchObject({ type: "wait" });
    expect(
      decodeCommand({
        id: "cmd-10",
        threadId: "thread-1",
        type: "press-key",
        key: "Enter",
      }),
    ).toMatchObject({ type: "press-key" });
    expect(
      decodeCommand({
        id: "cmd-11",
        threadId: "thread-1",
        type: "scroll",
        deltaY: 600,
      }),
    ).toMatchObject({ type: "scroll" });
    expect(
      decodeCommand({
        id: "cmd-12",
        threadId: "thread-1",
        type: "console",
        clear: true,
      }),
    ).toMatchObject({ type: "console" });
  });

  it("rejects malformed commands and invalid actions", () => {
    expect(() =>
      decodeCommand({
        id: "cmd-missing",
        threadId: "thread-1",
        type: "evaluate",
      }),
    ).toThrow();
    expect(() =>
      decodeCommand({
        id: "cmd-invalid-action",
        threadId: "thread-1",
        type: "action",
        action: "print",
      }),
    ).toThrow();
    expect(() =>
      decodeCommand({
        id: "cmd-missing-selector",
        threadId: "thread-1",
        type: "click-selector",
      }),
    ).toThrow();
  });
});

describe("BrowserPanelCommandResult", () => {
  it("accepts structured success and failure results", () => {
    expect(
      decodeResult({
        id: "cmd-1",
        threadId: "thread-1",
        ok: true,
        value: { title: "Example" },
      }),
    ).toMatchObject({ ok: true, value: { title: "Example" } });
    expect(
      decodeResult({
        id: "cmd-2",
        threadId: "thread-1",
        ok: false,
        error: "Browser panel unavailable.",
      }),
    ).toMatchObject({ ok: false, error: "Browser panel unavailable." });
  });
});
