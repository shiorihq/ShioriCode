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
