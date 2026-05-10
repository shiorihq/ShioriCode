import type { BrowserPanelCommand } from "contracts";

import {
  type BrowserPanelConsoleEntry,
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

export interface BrowserPanelCommandRunContext {
  readonly consoleEntries?: readonly BrowserPanelConsoleEntry[];
  readonly clearConsoleEntries?: () => void;
}

export function snapshotScript(input: Extract<BrowserPanelCommand, { type: "snapshot" }>): string {
  const maxElements = Math.min(Math.max(input.maxElements ?? 80, 0), 500);
  return `
(() => {
  const maxElements = ${maxElements};
  const cssEscape = (value) => {
    if (window.CSS && typeof window.CSS.escape === "function") return window.CSS.escape(value);
    return String(value).replace(/[^a-zA-Z0-9_-]/g, "\\\\$&");
  };
  const normalizedText = (value) => (value || "").replace(/\\s+/g, " ").trim();
  const cssPath = (element) => {
    if (!(element instanceof Element)) return null;
    if (element.id) return "#" + cssEscape(element.id);
    const parts = [];
    let current = element;
    while (current && current.nodeType === Node.ELEMENT_NODE && current !== document.documentElement) {
      let part = current.tagName.toLowerCase();
      const parent = current.parentElement;
      if (!parent) break;
      const siblings = Array.from(parent.children).filter((child) => child.tagName === current.tagName);
      if (siblings.length > 1) part += ":nth-of-type(" + (siblings.indexOf(current) + 1) + ")";
      parts.unshift(part);
      current = parent;
      if (parts.length >= 6) break;
    }
    return parts.length > 0 ? parts.join(" > ") : null;
  };
  const isVisible = (element) => {
    if (!(element instanceof Element)) return false;
    const rect = element.getBoundingClientRect();
    const style = window.getComputedStyle(element);
    return rect.width > 0 && rect.height > 0 && style.visibility !== "hidden" && style.display !== "none";
  };
  const elementName = (element) => normalizedText(
    element.getAttribute("aria-label")
      || element.getAttribute("alt")
      || element.getAttribute("title")
      || element.getAttribute("placeholder")
      || element.innerText
      || element.getAttribute("value")
      || ""
  ).slice(0, 300);
  const inferRole = (element) => {
    const explicit = element.getAttribute("role");
    if (explicit) return explicit;
    const tag = element.tagName.toLowerCase();
    if (tag === "a" && element.hasAttribute("href")) return "link";
    if (tag === "button") return "button";
    if (tag === "select") return "combobox";
    if (tag === "textarea") return "textbox";
    if (tag === "input") {
      const type = (element.getAttribute("type") || "text").toLowerCase();
      if (type === "checkbox") return "checkbox";
      if (type === "radio") return "radio";
      if (type === "button" || type === "submit" || type === "reset") return "button";
      return "textbox";
    }
    if (element.isContentEditable) return "textbox";
    return null;
  };
  const visibleText = ${input.includeText !== false}
    ? normalizedText(document.body?.innerText || "").slice(0, 20000)
    : undefined;
  const links = ${input.includeLinks !== false}
    ? Array.from(document.querySelectorAll("a[href]")).slice(0, 200).map((anchor) => ({
        text: normalizedText(anchor.innerText || anchor.getAttribute("aria-label") || ""),
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
        text: normalizedText(element.innerText || element.getAttribute("aria-label") || element.getAttribute("value") || ""),
        selectorHint: element.id ? "#" + cssEscape(element.id) : element.getAttribute("name") ? element.tagName.toLowerCase() + "[name='" + cssEscape(element.getAttribute("name")) + "']" : undefined,
      }))
    : undefined;
  const elements = ${input.includeElements !== false}
    ? Array.from(document.querySelectorAll("a[href], button, input, textarea, select, summary, [role], [tabindex], [contenteditable='true']"))
        .filter(isVisible)
        .slice(0, maxElements)
        .map((element, index) => {
          const rect = element.getBoundingClientRect();
          const tag = element.tagName.toLowerCase();
          return {
            index,
            role: inferRole(element),
            tag,
            name: elementName(element),
            selector: cssPath(element),
            text: normalizedText(element.innerText || "").slice(0, 300) || undefined,
            href: element instanceof HTMLAnchorElement ? element.href : undefined,
            value: "value" in element ? String(element.value ?? "").slice(0, 300) : undefined,
            checked: "checked" in element ? Boolean(element.checked) : undefined,
            disabled: "disabled" in element ? Boolean(element.disabled) : undefined,
            rect: {
              x: Math.round(rect.x),
              y: Math.round(rect.y),
              width: Math.round(rect.width),
              height: Math.round(rect.height),
            },
          };
        })
    : undefined;
  return {
    title: document.title,
    url: location.href,
    readyState: document.readyState,
    viewport: {
      width: window.innerWidth,
      height: window.innerHeight,
      deviceScaleFactor: window.devicePixelRatio,
      scrollX: Math.round(window.scrollX),
      scrollY: Math.round(window.scrollY),
    },
    activeElement: document.activeElement ? {
      tag: document.activeElement.tagName.toLowerCase(),
      name: elementName(document.activeElement),
      selector: cssPath(document.activeElement),
    } : null,
    text: visibleText,
    links,
    forms,
    elements,
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

function setElementValueScript(selector: string, text: string, mode: "type" | "fill"): string {
  return `
(() => {
  const selector = ${JSON.stringify(selector)};
  const text = ${JSON.stringify(text)};
  const mode = ${JSON.stringify(mode)};
  const element = document.querySelector(selector);
  if (!element) return { ok: false, error: "No element matched selector: " + selector };
  element.scrollIntoView({ block: "center", inline: "center" });
  element.focus();
  if ("value" in element) {
    element.value = mode === "type" ? String(element.value || "") + text : text;
    element.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: text }));
    element.dispatchEvent(new Event("change", { bubbles: true }));
  } else {
    element.textContent = mode === "type" ? String(element.textContent || "") + text : text;
    element.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: text }));
  }
  return { ok: true, typed: mode === "type", filled: mode === "fill", selector };
})()
`;
}

export function typeSelectorScript(selector: string, text: string): string {
  return setElementValueScript(selector, text, "type");
}

export function fillSelectorScript(selector: string, text: string): string {
  return setElementValueScript(selector, text, "fill");
}

export function hoverSelectorScript(selector: string): string {
  return `
(() => {
  const selector = ${JSON.stringify(selector)};
  const element = document.querySelector(selector);
  if (!element) return { hovered: false, error: "No element matched selector: " + selector };
  element.scrollIntoView({ block: "center", inline: "center" });
  for (const type of ["pointerover", "mouseover", "pointermove", "mousemove"]) {
    element.dispatchEvent(new MouseEvent(type, { bubbles: true, view: window }));
  }
  return { hovered: true, selector, text: (element.innerText || element.getAttribute("aria-label") || "").trim() };
})()
`;
}

export function selectSelectorScript(selector: string, value: string): string {
  return `
(() => {
  const selector = ${JSON.stringify(selector)};
  const value = ${JSON.stringify(value)};
  const element = document.querySelector(selector);
  if (!element) return { selected: false, error: "No element matched selector: " + selector };
  if (!(element instanceof HTMLSelectElement)) return { selected: false, error: "Matched element is not a select: " + selector };
  const option = Array.from(element.options).find((option) => option.value === value || option.label === value || option.text === value);
  if (!option) return { selected: false, error: "No option matched value or label: " + value };
  element.value = option.value;
  element.dispatchEvent(new Event("input", { bubbles: true }));
  element.dispatchEvent(new Event("change", { bubbles: true }));
  return { selected: true, selector, value: element.value, label: option.label || option.text };
})()
`;
}

export function waitScript(input: Extract<BrowserPanelCommand, { type: "wait" }>): string {
  return `
(() => new Promise((resolve) => {
  const selector = ${JSON.stringify(input.selector ?? null)};
  const text = ${JSON.stringify(input.text ?? null)};
  const timeoutMs = ${Math.min(Math.max(input.timeoutMs ?? 5000, 0), 30000)};
  const startedAt = Date.now();
  const isVisible = (element) => {
    if (!(element instanceof Element)) return false;
    const rect = element.getBoundingClientRect();
    const style = window.getComputedStyle(element);
    return rect.width > 0 && rect.height > 0 && style.visibility !== "hidden" && style.display !== "none";
  };
  const check = () => {
    const selectorMatch = selector ? Array.from(document.querySelectorAll(selector)).find(isVisible) : null;
    const textMatch = text ? (document.body?.innerText || "").includes(text) : false;
    if (selectorMatch || textMatch) {
      resolve({ matched: true, selector: selector || undefined, text: text || undefined, elapsedMs: Date.now() - startedAt });
      return;
    }
    if (Date.now() - startedAt >= timeoutMs) {
      resolve({ matched: false, selector: selector || undefined, text: text || undefined, elapsedMs: Date.now() - startedAt });
      return;
    }
    setTimeout(check, 100);
  };
  check();
}))()
`;
}

export function scrollScript(input: Extract<BrowserPanelCommand, { type: "scroll" }>): string {
  return `
(() => {
  const selector = ${JSON.stringify(input.selector ?? null)};
  const deltaX = ${input.deltaX ?? 0};
  const deltaY = ${input.deltaY ?? 600};
  const target = selector ? document.querySelector(selector) : window;
  if (!target) return { scrolled: false, error: "No element matched selector: " + selector };
  target.scrollBy({ left: deltaX, top: deltaY, behavior: "instant" });
  return {
    scrolled: true,
    selector: selector || undefined,
    scrollX: selector ? target.scrollLeft : window.scrollX,
    scrollY: selector ? target.scrollTop : window.scrollY,
  };
})()
`;
}

export function pressKeyScript(key: string): string {
  return `
(() => {
  const raw = ${JSON.stringify(key)};
  const parts = raw.split("+").map((part) => part.trim()).filter(Boolean);
  const key = parts.pop() || raw;
  const modifiers = new Set(parts.map((part) => part.toLowerCase()));
  const isMac = /Mac|iPhone|iPad/.test(navigator.platform);
  const eventInit = {
    key,
    bubbles: true,
    cancelable: true,
    altKey: modifiers.has("alt") || modifiers.has("option"),
    ctrlKey: modifiers.has("ctrl") || modifiers.has("control") || (modifiers.has("mod") && !isMac),
    metaKey: modifiers.has("meta") || modifiers.has("cmd") || modifiers.has("command") || (modifiers.has("mod") && isMac),
    shiftKey: modifiers.has("shift"),
  };
  const target = document.activeElement || document.body || document.documentElement;
  target.dispatchEvent(new KeyboardEvent("keydown", eventInit));
  target.dispatchEvent(new KeyboardEvent("keyup", eventInit));
  return { pressed: true, key: raw };
})()
`;
}

function snapshotValue(webview: BrowserWebviewElement): BrowserPanelSnapshot {
  return readWebviewSnapshot(webview, null);
}

function pageValueResult(value: unknown): BrowserPanelCommandRunResult {
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    if (typeof record.error === "string") {
      return { ok: false, error: record.error, value };
    }
    if (record.matched === false) {
      return { ok: false, error: "Timed out waiting for the browser page.", value };
    }
  }
  return { ok: true, value };
}

function inputEventForKey(key: string): { keyCode: string; modifiers: string[] } {
  const parts = key
    .split("+")
    .map((part) => part.trim())
    .filter(Boolean);
  const keyCode = parts.pop() || key;
  const isMac =
    typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform ?? "");
  const modifiers = parts.flatMap((part) => {
    switch (part.toLowerCase()) {
      case "alt":
      case "option":
        return ["alt"];
      case "ctrl":
      case "control":
        return ["control"];
      case "cmd":
      case "command":
      case "meta":
        return ["meta"];
      case "mod":
        return [isMac ? "meta" : "control"];
      case "shift":
        return ["shift"];
      default:
        return [];
    }
  });
  return { keyCode, modifiers: [...new Set(modifiers)] };
}

export async function runBrowserPanelCommandOnWebview(
  request: BrowserPanelCommand,
  webview: BrowserWebviewElement,
  context: BrowserPanelCommandRunContext = {},
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

    if (request.type === "console") {
      const value = { messages: context.consoleEntries ?? [] };
      if (request.clear) {
        context.clearConsoleEntries?.();
      }
      return { ok: true, value };
    }

    if (request.type === "press-key" && webview.sendInputEvent) {
      const inputEvent = inputEventForKey(request.key);
      webview.sendInputEvent({
        type: "keyDown",
        keyCode: inputEvent.keyCode,
        modifiers: inputEvent.modifiers,
      });
      webview.sendInputEvent({
        type: "keyUp",
        keyCode: inputEvent.keyCode,
        modifiers: inputEvent.modifiers,
      });
      return { ok: true, value: { pressed: true, key: request.key } };
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
      return pageValueResult(
        await webview.executeJavaScript(clickSelectorScript(request.selector), true),
      );
    }

    if (request.type === "hover-selector") {
      return pageValueResult(
        await webview.executeJavaScript(hoverSelectorScript(request.selector), true),
      );
    }

    if (request.type === "fill-selector") {
      return pageValueResult(
        await webview.executeJavaScript(
          fillSelectorScript(request.selector, request.text ?? ""),
          true,
        ),
      );
    }

    if (request.type === "select-selector") {
      return pageValueResult(
        await webview.executeJavaScript(
          selectSelectorScript(request.selector, request.value ?? ""),
          true,
        ),
      );
    }

    if (request.type === "wait") {
      return pageValueResult(await webview.executeJavaScript(waitScript(request), true));
    }

    if (request.type === "scroll") {
      return pageValueResult(await webview.executeJavaScript(scrollScript(request), true));
    }

    if (request.type === "press-key") {
      return {
        ok: true,
        value: await webview.executeJavaScript(pressKeyScript(request.key), true),
      };
    }

    return pageValueResult(
      await webview.executeJavaScript(
        typeSelectorScript(request.selector, request.text ?? ""),
        true,
      ),
    );
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}
