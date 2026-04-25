import type { ThreadId } from "contracts";

export type BrowserInteractionMode = "browse";

export interface BrowserPanelSnapshot {
  title: string;
  url: string;
  isLoading: boolean;
  canGoBack: boolean;
  canGoForward: boolean;
  error: string | null;
}

export interface BrowserWebviewElement extends HTMLElement {
  getURL?: () => string;
  getTitle?: () => string;
  isLoading?: () => boolean;
  canGoBack?: () => boolean;
  canGoForward?: () => boolean;
  goBack?: () => void;
  goForward?: () => void;
  reload?: () => void;
  stop?: () => void;
  loadURL?: (url: string) => Promise<void>;
  executeJavaScript?: (code: string, userGesture?: boolean) => Promise<unknown>;
  getWebContentsId?: () => number;
}

export const DEFAULT_BROWSER_URL = "about:blank";

function isUrlWithScheme(value: string): boolean {
  return /^[a-z][a-z0-9+.-]*:/i.test(value);
}

export function normalizeBrowserAddressInput(value: string): string {
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    return DEFAULT_BROWSER_URL;
  }
  if (trimmed === DEFAULT_BROWSER_URL) {
    return trimmed;
  }
  if (trimmed.startsWith("/") || trimmed.startsWith("~/")) {
    return `file://${trimmed.startsWith("~") ? trimmed : trimmed}`;
  }
  if (
    trimmed.startsWith("localhost") ||
    trimmed.startsWith("127.0.0.1") ||
    trimmed.startsWith("0.0.0.0") ||
    /^\[[0-9a-f:]+\]/i.test(trimmed)
  ) {
    return `http://${trimmed}`;
  }
  if (isUrlWithScheme(trimmed)) {
    return trimmed;
  }
  return `https://${trimmed}`;
}

export function browserPartitionForThread(threadId: ThreadId): string {
  return `persist:shioricode-browser-${encodeURIComponent(threadId)}`;
}

function readWebviewUrl(webview: BrowserWebviewElement): string {
  try {
    const url = webview.getURL?.() ?? webview.getAttribute("src") ?? "";
    return url === DEFAULT_BROWSER_URL ? "" : url;
  } catch {
    return "";
  }
}

function readWebviewTitle(webview: BrowserWebviewElement, url: string): string {
  try {
    const title = webview.getTitle?.().trim() ?? "";
    if (title.length > 0) {
      return title;
    }
  } catch {
    // Fall back to URL-derived display below.
  }

  if (url.length === 0) {
    return "New page";
  }

  try {
    return new URL(url).hostname || url;
  } catch {
    return url;
  }
}

function readWebviewBoolean(
  webview: BrowserWebviewElement,
  key: "isLoading" | "canGoBack" | "canGoForward",
): boolean {
  const reader = webview[key] as (() => boolean) | undefined;
  if (typeof reader !== "function") {
    return false;
  }
  try {
    return Boolean((reader as (this: BrowserWebviewElement) => unknown).call(webview));
  } catch {
    return false;
  }
}

export function readWebviewSnapshot(
  webview: BrowserWebviewElement,
  error: string | null,
): BrowserPanelSnapshot {
  const url = readWebviewUrl(webview);
  return {
    title: readWebviewTitle(webview, url),
    url,
    isLoading: readWebviewBoolean(webview, "isLoading"),
    canGoBack: readWebviewBoolean(webview, "canGoBack"),
    canGoForward: readWebviewBoolean(webview, "canGoForward"),
    error,
  };
}
