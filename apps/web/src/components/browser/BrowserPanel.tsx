import type { BrowserPanelCommand, ThreadId } from "contracts";
import {
  IconArrowLeftOutline24 as ArrowLeftIcon,
  IconArrowRightOutline24 as ArrowRightIcon,
  IconCameraOutline24 as CameraIcon,
  IconExternalLinkOutline24 as ExternalLinkIcon,
  IconGlobeOutline24 as GlobeIcon,
  IconRefreshOutline24 as RefreshCwIcon,
  IconMagnifierOutline24 as SearchIcon,
  IconXmarkOutline24 as XIcon,
} from "nucleo-core-outline-24";
import {
  type FormEvent,
  type ReactNode,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";

import { isElectron } from "~/env";
import { cn } from "~/lib/utils";
import { readNativeApi } from "~/nativeApi";
import { Button } from "../ui/button";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { toastManager } from "../ui/toast";
import { runBrowserPanelCommandOnWebview } from "./browserPanelCommandRunner";
import {
  type BrowserPanelConsoleEntry,
  type BrowserPanelSnapshot,
  type BrowserWebviewElement,
  DEFAULT_BROWSER_URL,
  browserPartitionForThread,
  normalizeBrowserAddressInput,
  readWebviewSnapshot,
} from "./browserWebviewStore";

const BLANK_SNAPSHOT: BrowserPanelSnapshot = {
  title: "New page",
  url: "",
  isLoading: false,
  canGoBack: false,
  canGoForward: false,
  error: null,
};

function isUsableBrowserUrl(url: string): boolean {
  return url.trim().length > 0;
}

function applyWebviewSize(webview: BrowserWebviewElement, host: HTMLElement): void {
  const width = Math.max(1, host.clientWidth);
  const height = Math.max(1, host.clientHeight);
  webview.style.width = `${width}px`;
  webview.style.height = `${height}px`;
}

interface BrowserPanelProps {
  threadId: ThreadId;
  active: boolean;
  cwd: string | null;
  isAgentWorking: boolean;
  onClose?: () => void;
  onStopAgent?: () => void;
}

export default function BrowserPanel({
  threadId,
  active,
  cwd,
  isAgentWorking,
  onClose,
  onStopAgent,
}: BrowserPanelProps) {
  const browserAvailable =
    isElectron && window.desktopBridge?.browser?.captureVisiblePage !== undefined;
  const viewportRef = useRef<HTMLDivElement | null>(null);
  const webviewRef = useRef<BrowserWebviewElement | null>(null);
  const pendingNavigateUrlRef = useRef<string | null>(null);
  const consoleEntriesRef = useRef<BrowserPanelConsoleEntry[]>([]);
  const [snapshot, setSnapshot] = useState<BrowserPanelSnapshot>(BLANK_SNAPSHOT);
  const [address, setAddress] = useState(snapshot.url);
  const [addressFocused, setAddressFocused] = useState(false);

  useEffect(() => {
    if (!addressFocused) {
      setAddress(snapshot.url);
    }
  }, [addressFocused, snapshot.url]);

  useLayoutEffect(() => {
    if (!browserAvailable) {
      return;
    }

    const viewport = viewportRef.current;
    if (!viewport || !active) {
      return;
    }

    const webview = document.createElement("webview") as BrowserWebviewElement;
    webviewRef.current = webview;
    consoleEntriesRef.current = [];
    webview.setAttribute("partition", browserPartitionForThread(threadId));
    webview.setAttribute("src", DEFAULT_BROWSER_URL);
    webview.setAttribute("allowpopups", "false");
    webview.style.position = "absolute";
    webview.style.inset = "0";
    // Electron's <webview> uses flex internally so the guest iframe fills the tag.
    // Changing this to block clips the guest surface even when the host is full height.
    webview.style.display = "flex";
    webview.style.border = "0";
    webview.style.boxSizing = "border-box";
    webview.style.minWidth = "0";
    webview.style.minHeight = "0";
    applyWebviewSize(webview, viewport);
    viewport.append(webview);

    let error: string | null = null;
    const update = () => {
      setSnapshot(readWebviewSnapshot(webview, error));
    };
    const updateWithoutError = () => {
      error = null;
      update();
    };
    const updateWithError = (event: Event) => {
      const detail = event as Event & {
        errorCode?: number;
        errorDescription?: string;
      };
      if (detail.errorCode !== -3) {
        error = detail.errorDescription ?? "Unable to load this page.";
      }
      update();
    };
    const recordConsoleMessage = (event: Event) => {
      const detail = event as Event & {
        level?: number | string;
        message?: string;
        sourceId?: string;
        line?: number;
      };
      const level =
        typeof detail.level === "number"
          ? (["log", "warning", "error", "debug"][detail.level] ?? String(detail.level))
          : (detail.level ?? "log");
      consoleEntriesRef.current = [
        ...consoleEntriesRef.current,
        {
          level,
          message: detail.message ?? "",
          sourceId: detail.sourceId ?? null,
          line: typeof detail.line === "number" ? detail.line : null,
          timestamp: Date.now(),
        },
      ].slice(-100);
    };
    const registrations: Array<[string, EventListener]> = [
      ["did-start-loading", updateWithoutError],
      ["did-stop-loading", update],
      ["did-navigate", updateWithoutError],
      ["did-navigate-in-page", update],
      ["page-title-updated", update],
      ["dom-ready", update],
      ["did-fail-load", updateWithError],
      ["console-message", recordConsoleMessage],
    ];
    for (const [eventName, listener] of registrations) {
      webview.addEventListener(eventName, listener);
    }

    const resizeObserver =
      typeof ResizeObserver === "undefined"
        ? null
        : new ResizeObserver(() => {
            applyWebviewSize(webview, viewport);
          });
    resizeObserver?.observe(viewport);
    update();

    const pendingNavigateUrl = pendingNavigateUrlRef.current;
    if (pendingNavigateUrl) {
      pendingNavigateUrlRef.current = null;
      void webview.loadURL?.(pendingNavigateUrl).catch((error) => {
        setSnapshot(readWebviewSnapshot(webview, String(error)));
      });
    }

    return () => {
      resizeObserver?.disconnect();
      for (const [eventName, listener] of registrations) {
        webview.removeEventListener(eventName, listener);
      }
      webview.remove();
      if (webviewRef.current === webview) {
        webviewRef.current = null;
      }
    };
  }, [active, browserAvailable, threadId]);

  useEffect(() => {
    const api = readNativeApi();
    const browserPanel = api?.browserPanel;
    if (!browserPanel) {
      return;
    }

    const complete = (
      request: BrowserPanelCommand,
      ok: boolean,
      value?: unknown,
      error?: string,
    ) => {
      void browserPanel.completeCommand({
        id: request.id,
        threadId: request.threadId,
        ok,
        ...(value !== undefined ? { value } : {}),
        ...(error ? { error } : {}),
      });
    };

    const executeCommand = async (request: BrowserPanelCommand) => {
      if (request.threadId !== threadId) {
        return;
      }
      const webview = webviewRef.current;
      if (!webview) {
        if (request.type === "navigate") {
          const nextUrl = normalizeBrowserAddressInput(request.url);
          pendingNavigateUrlRef.current = nextUrl;
        }
        complete(request, false, undefined, "The Browser panel webview is not ready.");
        return;
      }

      try {
        const result = await runBrowserPanelCommandOnWebview(request, webview, {
          consoleEntries: consoleEntriesRef.current,
          clearConsoleEntries: () => {
            consoleEntriesRef.current = [];
          },
        });
        if (result.address !== undefined) {
          setAddress(result.address);
        }
        complete(request, result.ok, result.value, result.error);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        setSnapshot(readWebviewSnapshot(webview, message));
        complete(request, false, undefined, message);
      }
    };

    return browserPanel.onNavigateRequest((request) => {
      void executeCommand(request);
    });
  }, [threadId]);

  const submitAddress = useCallback(
    (event?: FormEvent<HTMLFormElement>) => {
      event?.preventDefault();
      const webview = webviewRef.current;
      if (!webview) {
        return;
      }
      const nextUrl = normalizeBrowserAddressInput(address);
      setAddress(nextUrl === DEFAULT_BROWSER_URL ? "" : nextUrl);
      if (!webview.loadURL) {
        webview.setAttribute("src", nextUrl);
        setAddressFocused(false);
        return;
      }
      void webview.loadURL(nextUrl).catch((error) => {
        setSnapshot(readWebviewSnapshot(webview, String(error)));
      });
      setAddressFocused(false);
    },
    [address],
  );

  const captureScreenshot = useCallback(() => {
    const webview = webviewRef.current;
    if (!webview || !window.desktopBridge?.browser) {
      return;
    }

    const webContentsId = webview.getWebContentsId?.();
    if (typeof webContentsId !== "number") {
      toastManager.add({
        type: "error",
        title: "Screenshot unavailable",
        description: "The browser page is still starting.",
      });
      return;
    }

    void window.desktopBridge.browser
      .captureVisiblePage({ threadId, webContentsId })
      .then((result) => {
        if (!result.ok) {
          toastManager.add({
            type: "error",
            title: "Could not capture screenshot",
            description: result.message ?? "An unknown error occurred.",
          });
          return;
        }
        toastManager.add({
          type: "success",
          title: "Screenshot copied",
          description: "The browser viewport is on your clipboard.",
        });
      })
      .catch((error) => {
        toastManager.add({
          type: "error",
          title: "Could not capture screenshot",
          description: error instanceof Error ? error.message : "An unknown error occurred.",
        });
      });
  }, [threadId]);

  const openExternal = useCallback(() => {
    if (!isUsableBrowserUrl(snapshot.url)) {
      return;
    }
    const api = readNativeApi();
    void api?.shell.openExternal(snapshot.url).catch((error) => {
      toastManager.add({
        type: "error",
        title: "Could not open browser",
        description: error instanceof Error ? error.message : "An unknown error occurred.",
      });
    });
  }, [snapshot.url]);

  if (!browserAvailable) {
    return (
      <div className="flex h-full min-h-0 flex-col bg-card text-foreground">
        <BrowserPanelHeader title="Browser" {...(onClose ? { onClose } : {})} />
        <div className="flex min-h-0 flex-1 items-center justify-center px-8 text-center">
          <div className="max-w-sm">
            <GlobeIcon className="mx-auto mb-3 size-8 text-muted-foreground/60" />
            <h3 className="text-sm font-medium text-foreground">Desktop browser unavailable</h3>
            <p className="mt-2 text-muted-foreground text-sm leading-6">
              The integrated browser is available in the ShioriCode desktop app.
            </p>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="flex h-full min-h-0 min-w-0 flex-1 flex-col bg-card text-foreground">
      <div className="shrink-0 border-b border-border/70 bg-card">
        <BrowserPanelHeader
          title={snapshot.title}
          isAgentWorking={isAgentWorking}
          {...(onClose ? { onClose } : {})}
          {...(onStopAgent ? { onStopAgent } : {})}
        />
        <form className="flex min-w-0 items-center gap-1 px-2 pb-2" onSubmit={submitAddress}>
          <ToolbarButton
            label="Back"
            disabled={!snapshot.canGoBack}
            onClick={() => webviewRef.current?.goBack?.()}
          >
            <ArrowLeftIcon />
          </ToolbarButton>
          <ToolbarButton
            label="Forward"
            disabled={!snapshot.canGoForward}
            onClick={() => webviewRef.current?.goForward?.()}
          >
            <ArrowRightIcon />
          </ToolbarButton>
          <ToolbarButton
            label={snapshot.isLoading ? "Stop loading" : "Reload"}
            disabled={!snapshot.isLoading && snapshot.url.length === 0}
            onClick={() =>
              snapshot.isLoading ? webviewRef.current?.stop?.() : webviewRef.current?.reload?.()
            }
          >
            {snapshot.isLoading ? <XIcon /> : <RefreshCwIcon />}
          </ToolbarButton>
          <div className="relative min-w-0 flex-1">
            <SearchIcon className="-translate-y-1/2 pointer-events-none absolute left-2.5 top-1/2 size-3.5 text-muted-foreground/60" />
            <input
              value={address}
              onChange={(event) => setAddress(event.currentTarget.value)}
              onFocus={() => setAddressFocused(true)}
              onBlur={() => setAddressFocused(false)}
              placeholder="Enter a URL"
              className={cn(
                "h-8 w-full min-w-0 rounded-md border border-border bg-background pl-8 pr-2",
                "text-sm text-foreground outline-none transition-colors",
                "placeholder:text-muted-foreground/60 focus:border-ring/60",
              )}
              spellCheck={false}
            />
          </div>
          <ToolbarButton
            label="Open externally"
            disabled={!isUsableBrowserUrl(snapshot.url)}
            onClick={openExternal}
          >
            <ExternalLinkIcon />
          </ToolbarButton>
          <ToolbarButton
            label="Capture screenshot"
            disabled={!isUsableBrowserUrl(snapshot.url)}
            onClick={captureScreenshot}
          >
            <CameraIcon />
          </ToolbarButton>
        </form>
      </div>

      <div className="relative min-h-0 min-w-0 flex-1 bg-background">
        <div
          ref={viewportRef}
          className="absolute inset-0 h-full min-h-0 w-full min-w-0 overflow-hidden [&>webview]:flex"
        />
        {!isUsableBrowserUrl(snapshot.url) ? (
          <div className="pointer-events-none absolute inset-0 z-10 flex items-center justify-center px-8 text-center">
            <div className="max-w-sm">
              <GlobeIcon className="mx-auto mb-3 size-9 text-muted-foreground/50" />
              <h3 className="text-sm font-medium text-foreground">New browser page</h3>
              <p className="mt-2 text-muted-foreground text-sm leading-6">
                Open a local dev server, docs page, or file preview.
              </p>
              {cwd ? (
                <p className="mt-3 truncate font-mono text-muted-foreground/70 text-xs" title={cwd}>
                  {cwd}
                </p>
              ) : null}
            </div>
          </div>
        ) : null}
        {snapshot.error ? (
          <div className="absolute inset-x-3 top-3 z-20 rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-destructive text-sm">
            {snapshot.error}
          </div>
        ) : null}
      </div>
    </div>
  );
}

function BrowserPanelHeader(props: {
  title: string;
  isAgentWorking?: boolean;
  onClose?: () => void;
  onStopAgent?: () => void;
}) {
  return (
    <div className="drag-region flex h-10 min-w-0 items-center gap-2 px-3">
      <GlobeIcon className="size-4 shrink-0 text-muted-foreground/80" />
      <div className="min-w-0 flex-1 truncate text-sm font-medium" title={props.title}>
        {props.title}
      </div>
      {props.isAgentWorking ? (
        <Button
          variant="outline"
          size="xs"
          className="shrink-0 [-webkit-app-region:no-drag]"
          onClick={props.onStopAgent}
        >
          Stop agent
        </Button>
      ) : null}
      {props.onClose ? (
        <Button
          variant="ghost"
          size="icon-xs"
          className="shrink-0 [-webkit-app-region:no-drag]"
          onClick={props.onClose}
          aria-label="Close browser panel"
        >
          <XIcon />
        </Button>
      ) : null}
    </div>
  );
}

function ToolbarButton(props: {
  label: string;
  disabled?: boolean;
  children: ReactNode;
  onClick: () => void;
}) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            disabled={props.disabled}
            aria-label={props.label}
            onClick={props.onClick}
          >
            {props.children}
          </Button>
        }
      />
      <TooltipPopup side="bottom">{props.label}</TooltipPopup>
    </Tooltip>
  );
}
