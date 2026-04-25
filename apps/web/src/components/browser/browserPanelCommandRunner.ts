import type { BrowserPanelCommand } from "contracts";

import {
  type BrowserPanelSnapshot,
  type BrowserWebviewElement,
  DEFAULT_BROWSER_URL,
  normalizeBrowserAddressInput,
  readWebviewSnapshot,
} from "./browserWebviewStore";

export interface BrowserPanelCommandRunResult {
  readonly ok: boolean;
  readonly value?: unknown;
  readonly error?: string;
  readonly address?: string;
}

export function snapshotScript(input: Extract<BrowserPanelCommand, { type: "snapshot" }>): string {
  return `
(() => {
  const visibleText = ${input.includeText !== false}
    ? (document.body?.innerText || "").replace(/\\s+/g, " ").trim().slice(0, 20000)
    : undefined;
  const links = ${input.includeLinks !== false}
    ? Array.from(document.querySelectorAll("a[href]")).slice(0, 200).map((anchor) => ({
        text: (anchor.innerText || anchor.getAttribute("aria-label") || "").replace(/\\s+/g, " ").trim(),
        href: anchor.href,
      }))
    : undefined;
  const forms = ${input.includeForms !== false}
    ? Array.from(document.querySelectorAll("input, textarea, select, button, [contenteditable='true']")).slice(0, 200).map((element) => ({
        tag: element.tagName.toLowerCase(),
        type: element.getAttribute("type") || undefined,
        name: element.getAttribute("name") || undefined,
        id: element.id || undefined,
        placeholder: element.getAttribute("placeholder") || undefined,
        text: (element.innerText || element.getAttribute("aria-label") || element.getAttribute("value") || "").replace(/\\s+/g, " ").trim(),
        selectorHint: element.id ? "#" + CSS.escape(element.id) : element.getAttribute("name") ? element.tagName.toLowerCase() + "[name='" + CSS.escape(element.getAttribute("name")) + "']" : undefined,
      }))
    : undefined;
  return {
    title: document.title,
    url: location.href,
    readyState: document.readyState,
    text: visibleText,
    links,
    forms,
  };
})()
`;
}

export function clickSelectorScript(selector: string): string {
  return `
(() => {
  const selector = ${JSON.stringify(selector)};
  const element = document.querySelector(selector);
  if (!element) return { clicked: false, error: "No element matched selector: " + selector };
  element.scrollIntoView({ block: "center", inline: "center" });
  element.click();
  return { clicked: true, selector, text: (element.innerText || element.getAttribute("aria-label") || "").trim() };
})()
`;
}

export function typeSelectorScript(selector: string, text: string): string {
  return `
(() => {
  const selector = ${JSON.stringify(selector)};
  const text = ${JSON.stringify(text)};
  const element = document.querySelector(selector);
  if (!element) return { typed: false, error: "No element matched selector: " + selector };
  element.scrollIntoView({ block: "center", inline: "center" });
  element.focus();
  if ("value" in element) {
    element.value = text;
    element.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: text }));
    element.dispatchEvent(new Event("change", { bubbles: true }));
  } else {
    element.textContent = text;
    element.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: text }));
  }
  return { typed: true, selector };
})()
`;
}

function snapshotValue(webview: BrowserWebviewElement): BrowserPanelSnapshot {
  return readWebviewSnapshot(webview, null);
}

export async function runBrowserPanelCommandOnWebview(
  request: BrowserPanelCommand,
  webview: BrowserWebviewElement,
): Promise<BrowserPanelCommandRunResult> {
  try {
    if (request.type === "navigate") {
      const nextUrl = normalizeBrowserAddressInput(request.url);
      if (webview.loadURL) {
        await webview.loadURL(nextUrl);
      } else {
        webview.setAttribute("src", nextUrl);
      }
      return {
        ok: true,
        address: nextUrl === DEFAULT_BROWSER_URL ? "" : nextUrl,
        value: snapshotValue(webview),
      };
    }

    if (request.type === "action") {
      if (request.action === "back") webview.goBack?.();
      if (request.action === "forward") webview.goForward?.();
      if (request.action === "reload") webview.reload?.();
      if (request.action === "stop") webview.stop?.();
      return { ok: true, value: snapshotValue(webview) };
    }

    if (!webview.executeJavaScript) {
      return { ok: false, error: "This Browser panel cannot execute JavaScript yet." };
    }

    if (request.type === "evaluate") {
      return { ok: true, value: await webview.executeJavaScript(request.script, true) };
    }

    if (request.type === "snapshot") {
      const page = await webview.executeJavaScript(snapshotScript(request), true);
      return { ok: true, value: { ...snapshotValue(webview), page } };
    }

    if (request.type === "click-selector") {
      return {
        ok: true,
        value: await webview.executeJavaScript(clickSelectorScript(request.selector), true),
      };
    }

    return {
      ok: true,
      value: await webview.executeJavaScript(
        typeSelectorScript(request.selector, request.text ?? ""),
        true,
      ),
    };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}
