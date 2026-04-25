import {
  BrowserWindow,
  Menu,
  clipboard,
  ipcMain,
  session,
  shell,
  webContents as electronWebContents,
} from "electron";
import type { MenuItemConstructorOptions } from "electron";
import type { DesktopBrowserCaptureResult } from "contracts";

export const BROWSER_CAPTURE_VISIBLE_PAGE_CHANNEL = "desktop:browser-capture-visible-page";

const BROWSER_PARTITION_PREFIX = "persist:shioricode-browser-";
const configuredBrowserPartitions = new Set<string>();
const browserSessionPartitions = new Map<Electron.Session, string>();
const attachedBrowserWebviews = new Map<
  number,
  {
    readonly ownerWebContentsId: number;
    readonly threadId: string;
  }
>();

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isSafeBrowserPartition(partition: unknown): partition is string {
  return typeof partition === "string" && partition.startsWith(BROWSER_PARTITION_PREFIX);
}

function threadIdFromBrowserPartition(partition: string): string | null {
  if (!isSafeBrowserPartition(partition)) {
    return null;
  }

  const encoded = partition.slice(BROWSER_PARTITION_PREFIX.length);
  try {
    return decodeURIComponent(encoded);
  } catch {
    return null;
  }
}

function isBrowserNavigationUrl(rawUrl: string): boolean {
  if (rawUrl === "about:blank") {
    return true;
  }
  try {
    const url = new URL(rawUrl);
    return url.protocol === "http:" || url.protocol === "https:" || url.protocol === "file:";
  } catch {
    return false;
  }
}

function isExternalOpenUrl(rawUrl: string): boolean {
  try {
    const url = new URL(rawUrl);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

function configureBrowserSession(partition: string): Electron.Session {
  const browserSession = session.fromPartition(partition);
  browserSessionPartitions.set(browserSession, partition);
  if (configuredBrowserPartitions.has(partition)) {
    return browserSession;
  }

  browserSession.setPermissionRequestHandler((_webContents, _permission, callback) => {
    callback(false);
  });
  browserSession.setPermissionCheckHandler(() => false);
  browserSession.on("will-download", (event, item) => {
    event.preventDefault();
    item.cancel();
  });
  browserSession.webRequest.onBeforeRequest((details, callback) => {
    const isUnsafeTopLevelNavigation =
      details.resourceType === "mainFrame" && !isBrowserNavigationUrl(details.url);
    callback({ cancel: isUnsafeTopLevelNavigation });
  });

  configuredBrowserPartitions.add(partition);
  return browserSession;
}

function showBrowserContextMenu(
  ownerWindow: BrowserWindow,
  contents: Electron.WebContents,
  params: Electron.ContextMenuParams,
): void {
  const template: MenuItemConstructorOptions[] = [
    { role: "cut", enabled: params.editFlags.canCut },
    { role: "copy", enabled: params.editFlags.canCopy },
    { role: "paste", enabled: params.editFlags.canPaste },
    { type: "separator" },
    {
      label: "Inspect",
      click: () => {
        if (!contents.isDestroyed()) {
          contents.inspectElement(params.x, params.y);
        }
      },
    },
  ];

  Menu.buildFromTemplate(template).popup({ window: ownerWindow });
}

function handleBlockedNavigation(url: string): void {
  if (!isExternalOpenUrl(url)) {
    return;
  }
  void shell.openExternal(url).catch((error) => {
    console.warn("[desktop] failed to open blocked browser URL externally", error);
  });
}

function configureAttachedBrowserWebContents(
  ownerWindow: BrowserWindow,
  contents: Electron.WebContents,
): void {
  contents.setWindowOpenHandler(({ url }) => {
    if (isBrowserNavigationUrl(url)) {
      void contents.loadURL(url).catch((error) => {
        console.warn("[desktop] failed to open browser panel popup URL", error);
      });
    } else {
      handleBlockedNavigation(url);
    }
    return { action: "deny" };
  });

  contents.on("will-navigate", (event, url) => {
    if (isBrowserNavigationUrl(url)) {
      return;
    }
    event.preventDefault();
    handleBlockedNavigation(url);
  });

  contents.on("context-menu", (_event, params) => {
    if (!ownerWindow.isDestroyed() && !contents.isDestroyed()) {
      showBrowserContextMenu(ownerWindow, contents, params);
    }
  });

  contents.on("render-process-gone", (_event, details) => {
    console.warn("[desktop] browser panel renderer exited", {
      reason: details.reason,
      exitCode: details.exitCode,
    });
  });
}

export function installBrowserPanelWebviewHandlers(window: BrowserWindow): void {
  window.webContents.on("will-attach-webview", (event, webPreferences, params) => {
    const partition = params.partition ?? webPreferences.partition;
    if (!isSafeBrowserPartition(partition)) {
      event.preventDefault();
      return;
    }

    webPreferences.nodeIntegration = false;
    webPreferences.contextIsolation = true;
    webPreferences.sandbox = true;
    webPreferences.webSecurity = true;
    webPreferences.allowRunningInsecureContent = false;
    webPreferences.plugins = false;
    webPreferences.session = configureBrowserSession(partition);
    webPreferences.partition = partition;
    delete webPreferences.preload;
    delete (webPreferences as { preloadURL?: unknown }).preloadURL;
  });

  window.webContents.on("did-attach-webview", (_event, contents) => {
    const partition = browserSessionPartitions.get(contents.session);
    const threadId = partition ? threadIdFromBrowserPartition(partition) : null;
    if (threadId) {
      attachedBrowserWebviews.set(contents.id, {
        ownerWebContentsId: window.webContents.id,
        threadId,
      });
      contents.once("destroyed", () => {
        attachedBrowserWebviews.delete(contents.id);
      });
    }
    configureAttachedBrowserWebContents(window, contents);
  });
}

function readCaptureInput(rawInput: unknown): { threadId: string; webContentsId: number } | null {
  if (!isRecord(rawInput)) {
    return null;
  }
  const threadId = rawInput.threadId;
  const webContentsId = rawInput.webContentsId;
  if (typeof threadId !== "string" || threadId.trim().length === 0) {
    return null;
  }
  if (typeof webContentsId !== "number" || !Number.isInteger(webContentsId) || webContentsId < 0) {
    return null;
  }
  return { threadId, webContentsId };
}

export function registerBrowserPanelIpcHandlers(): void {
  ipcMain.removeHandler(BROWSER_CAPTURE_VISIBLE_PAGE_CHANNEL);
  ipcMain.handle(
    BROWSER_CAPTURE_VISIBLE_PAGE_CHANNEL,
    async (event, rawInput: unknown): Promise<DesktopBrowserCaptureResult> => {
      const input = readCaptureInput(rawInput);
      if (!input) {
        return { ok: false, message: "Invalid browser capture request." };
      }

      const contents = electronWebContents.fromId(input.webContentsId);
      if (!contents || contents.isDestroyed()) {
        return { ok: false, message: "Browser page is no longer available." };
      }

      const registeredWebview = attachedBrowserWebviews.get(contents.id);
      if (
        !registeredWebview ||
        registeredWebview.ownerWebContentsId !== event.sender.id ||
        registeredWebview.threadId !== input.threadId ||
        contents.hostWebContents?.id !== event.sender.id
      ) {
        return { ok: false, message: "Browser page is not available for this thread." };
      }

      try {
        const image = await contents.capturePage();
        if (image.isEmpty()) {
          return { ok: false, message: "Browser page screenshot was empty." };
        }
        clipboard.writeImage(image);
        return { ok: true, message: null };
      } catch (error) {
        return {
          ok: false,
          message: error instanceof Error ? error.message : "Unable to capture browser page.",
        };
      }
    },
  );
}
