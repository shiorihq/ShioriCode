import { useCallback, useEffect, type CSSProperties, type ReactNode } from "react";
import { useNavigate } from "@tanstack/react-router";
import { useServerKeybindings } from "~/rpc/serverState";
import { useDesktopWindowControlsInset } from "~/hooks/useDesktopWindowControlsInset";
import { isTerminalFocused } from "~/lib/terminalFocus";
import { useTerminalStateStore } from "~/terminalStateStore";
import { useUiStateStore } from "~/uiStateStore";
import { cn, isMacPlatform } from "~/lib/utils";
import { isElectron } from "~/env";
import { useSettings } from "~/hooks/useSettings";
import { useHandleNewThread } from "~/hooks/useHandleNewThread";
import {
  normalizeAppearanceBackgroundBlur,
  normalizeAppearanceBackgroundOpacity,
  resolveAppearanceBackgroundUrl,
} from "~/lib/appearanceBackgrounds";
import { setActiveWallpaperUrl } from "~/lib/wallpaperLuminance";

import { AppWallpaper } from "./AppWallpaper";
import ThreadSidebar from "./Sidebar";
import {
  resolveAppSidebarShortcutCommand,
  resolveAppTitlebarWindowControlsLeftInset,
} from "./AppSidebarLayout.logic";
import { resolveSidebarNewThreadEnvMode } from "./Sidebar.logic";
import { CommandKModal, useCommandK } from "./CommandKModal";
import { Sidebar, SidebarProvider, SidebarRail, useSidebar } from "./ui/sidebar";

const THREAD_SIDEBAR_WIDTH_STORAGE_KEY = "chat_thread_sidebar_width";
const THREAD_SIDEBAR_MIN_WIDTH = 13 * 16;
const THREAD_MAIN_CONTENT_MIN_WIDTH = 40 * 16;

function AppSidebarKeyboardShortcuts({ onSearchOpen }: { onSearchOpen: () => void }) {
  const { toggleSidebar } = useSidebar();
  const keybindings = useServerKeybindings();
  const navigate = useNavigate();
  const appSettings = useSettings();
  const requestProjectAdd = useUiStateStore((state) => state.requestProjectAdd);
  const { activeDraftThread, activeThread, defaultProjectId, handleNewThread } =
    useHandleNewThread();
  const terminalOpen = useTerminalStateStore((state) =>
    Object.values(state.terminalStateByThreadId).some(
      (terminalState) => terminalState.terminalOpen,
    ),
  );

  useEffect(() => {
    const onWindowKeyDown = (event: KeyboardEvent) => {
      const terminalFocus = isTerminalFocused();
      const command = resolveAppSidebarShortcutCommand(event, keybindings, {
        terminalFocus,
        terminalOpen,
      });
      if (!command) return;

      if (command === "search.open") {
        event.preventDefault();
        event.stopPropagation();
        onSearchOpen();
        return;
      }

      if (command === "project.add") {
        event.preventDefault();
        event.stopPropagation();
        requestProjectAdd();
        return;
      }

      if (command === "pullRequests.open") {
        event.preventDefault();
        event.stopPropagation();
        void navigate({ to: "/pull-requests" });
        return;
      }

      const projectId = activeThread?.projectId ?? activeDraftThread?.projectId ?? defaultProjectId;

      if (command === "chat.newLocal") {
        if (!projectId) {
          return;
        }
        event.preventDefault();
        event.stopPropagation();
        void handleNewThread(projectId, {
          envMode: resolveSidebarNewThreadEnvMode({
            defaultEnvMode: appSettings.defaultThreadEnvMode,
          }),
        });
        return;
      }

      if (command === "chat.new") {
        if (!projectId) {
          return;
        }
        event.preventDefault();
        event.stopPropagation();
        void handleNewThread(projectId, {
          branch: activeThread?.branch ?? activeDraftThread?.branch ?? null,
          worktreePath: activeThread?.worktreePath ?? activeDraftThread?.worktreePath ?? null,
          envMode:
            activeDraftThread?.envMode ?? (activeThread?.worktreePath ? "worktree" : "local"),
        });
        return;
      }

      event.preventDefault();
      event.stopPropagation();
      toggleSidebar();
    };

    // Capture-phase handling lets app-level shortcuts override focused editors and
    // browser defaults like Cmd+P before those handlers consume the event.
    window.addEventListener("keydown", onWindowKeyDown, { capture: true });
    return () => {
      window.removeEventListener("keydown", onWindowKeyDown, { capture: true });
    };
  }, [
    activeDraftThread,
    activeThread,
    appSettings.defaultThreadEnvMode,
    defaultProjectId,
    handleNewThread,
    keybindings,
    navigate,
    onSearchOpen,
    requestProjectAdd,
    terminalOpen,
    toggleSidebar,
  ]);

  return null;
}

function AppSidebarContent({
  wallpaper,
  children,
}: {
  wallpaper: { url: string; opacity: number; blur: number } | null;
  children: ReactNode;
}) {
  const { isMobile, open: sidebarOpen } = useSidebar();
  const macWindowControlsInset = useDesktopWindowControlsInset();
  const titlebarWindowControlsLeftInset = resolveAppTitlebarWindowControlsLeftInset({
    isElectron,
    isMac: typeof navigator !== "undefined" && isMacPlatform(navigator.platform),
    sidebarOpen: sidebarOpen || isMobile,
    windowControlsInset: macWindowControlsInset,
  });
  const showCurvedSidebarEdge = sidebarOpen && !isMobile;
  const titlebarStyle =
    titlebarWindowControlsLeftInset > 0
      ? ({
          "--app-titlebar-window-controls-left-inset": `${titlebarWindowControlsLeftInset}px`,
        } as CSSProperties)
      : undefined;

  return (
    <div
      className={cn(
        "relative z-10 flex min-h-0 min-w-0 flex-1 flex-col",
        // bg-transparent when curved is load-bearing: it is the window through
        // which the sidebar's two corner squares are seen.
        showCurvedSidebarEdge ? "bg-transparent" : "bg-app-canvas",
      )}
      style={titlebarStyle}
    >
      <div
        className={cn(
          // Stays opaque: this is the plane the main wallpaper composites onto.
          "relative z-10 flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden bg-background",
          showCurvedSidebarEdge && "-ml-px rounded-l-[var(--app-sidebar-shell-radius)]",
        )}
        data-app-chat-shell-with-sidebar={showCurvedSidebarEdge || undefined}
        data-app-modal-blur-surface
      >
        {wallpaper ? <AppWallpaper region="main" {...wallpaper} /> : null}
        <div data-app-main-content className="relative z-10 flex min-h-0 min-w-0 flex-1 flex-col">
          {children}
        </div>
      </div>
    </div>
  );
}

function useSidebarTranslucency(enabled: boolean) {
  useEffect(() => {
    document.documentElement.toggleAttribute("data-sidebar-translucent", enabled);
    return () => {
      document.documentElement.removeAttribute("data-sidebar-translucent");
    };
  }, [enabled]);

  useEffect(() => {
    const bridge = window.desktopBridge;
    if (!bridge || typeof bridge.setVibrancy !== "function") return;
    void bridge.setVibrancy(enabled).catch(() => {});
  }, [enabled]);
}

export function AppSidebarLayout({ children }: { children: ReactNode }) {
  const navigate = useNavigate();
  const { appearanceBackground, sidebarTranslucent } = useSettings();
  const appearanceBackgroundUrl = resolveAppearanceBackgroundUrl(appearanceBackground);
  const appearanceBackgroundOpacity = normalizeAppearanceBackgroundOpacity(
    appearanceBackground?.opacity,
  );
  const appearanceBackgroundBlur = normalizeAppearanceBackgroundBlur(appearanceBackground?.blur);
  const mainBackgroundOpacity = normalizeAppearanceBackgroundOpacity(
    appearanceBackground?.mainOpacity,
  );
  const mainBackgroundBlur = normalizeAppearanceBackgroundBlur(appearanceBackground?.mainBlur);
  const { open: commandKOpen, setOpen: setCommandKOpen } = useCommandK();
  const openCommandK = useCallback(() => {
    setCommandKOpen(true);
  }, [setCommandKOpen]);
  // With a wallpaper on, the photo paints inside the shell on top of the
  // transparent window backing, fully occluding macOS vibrancy — so the two
  // are mutually exclusive and the tuned wallpaper tint wins.
  const translucent = isElectron && sidebarTranslucent && appearanceBackgroundUrl === null;
  useSidebarTranslucency(translucent);

  useEffect(() => {
    document.documentElement.toggleAttribute(
      "data-app-background",
      appearanceBackgroundUrl !== null,
    );
    return () => {
      document.documentElement.removeAttribute("data-app-background");
    };
  }, [appearanceBackgroundUrl]);

  // Feeds the luminance store that drives `themeMode: "wallpaper"` and the
  // scrim's mid-grey boost. Samples once per URL; a no-op on every render after.
  useEffect(() => {
    setActiveWallpaperUrl(appearanceBackgroundUrl);
  }, [appearanceBackgroundUrl]);

  useEffect(() => {
    const onMenuAction = window.desktopBridge?.onMenuAction;
    if (typeof onMenuAction !== "function") {
      return;
    }

    const unsubscribe = onMenuAction((action) => {
      if (action === "open-settings") {
        void navigate({ to: "/settings/general" });
      } else if (action === "open-settings-remote") {
        void navigate({ to: "/settings/remote" });
      }
    });

    return () => {
      unsubscribe?.();
    };
  }, [navigate, openCommandK]);

  return (
    <SidebarProvider
      defaultOpen
      data-app-background-shell={appearanceBackgroundUrl ? "true" : undefined}
      className="relative isolate h-dvh overflow-hidden"
    >
      {appearanceBackgroundUrl ? (
        <AppWallpaper
          region="shell"
          url={appearanceBackgroundUrl}
          opacity={appearanceBackgroundOpacity}
          blur={appearanceBackgroundBlur}
        />
      ) : null}
      <AppSidebarKeyboardShortcuts onSearchOpen={openCommandK} />
      <CommandKModal open={commandKOpen} onOpenChange={setCommandKOpen} />
      <Sidebar
        side="left"
        collapsible="offcanvas"
        data-app-sidebar-shell
        data-translucent={translucent || undefined}
        className="!border-r-0 bg-transparent text-foreground"
        resizable={{
          minWidth: THREAD_SIDEBAR_MIN_WIDTH,
          shouldAcceptWidth: ({ nextWidth, wrapper }) =>
            wrapper.clientWidth - nextWidth >= THREAD_MAIN_CONTENT_MIN_WIDTH,
          storageKey: THREAD_SIDEBAR_WIDTH_STORAGE_KEY,
        }}
      >
        <ThreadSidebar onSearchClick={openCommandK} />
        <SidebarRail />
      </Sidebar>
      <AppSidebarContent
        wallpaper={
          appearanceBackgroundUrl
            ? {
                url: appearanceBackgroundUrl,
                opacity: mainBackgroundOpacity,
                blur: mainBackgroundBlur,
              }
            : null
        }
      >
        {children}
      </AppSidebarContent>
    </SidebarProvider>
  );
}
