import { useCallback, useEffect, type CSSProperties, type ReactNode } from "react";
import { useLocation, useNavigate } from "@tanstack/react-router";
import { useServerKeybindings } from "~/rpc/serverState";
import { useDesktopWindowControlsInset } from "~/hooks/useDesktopWindowControlsInset";
import { isTerminalFocused } from "~/lib/terminalFocus";
import { useTerminalStateStore } from "~/terminalStateStore";
import { useUiStateStore } from "~/uiStateStore";
import { cn, isMacPlatform } from "~/lib/utils";
import { isElectron } from "~/env";
import { useSettings } from "~/hooks/useSettings";
import { useHandleNewThread } from "~/hooks/useHandleNewThread";
import { useGoalsFeatureEnabled } from "~/hooks/useGoalsFeatureEnabled";

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
  const pathname = useLocation({ select: (loc) => loc.pathname });
  const appSettings = useSettings();
  const goalsEnabled = useGoalsFeatureEnabled();
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
        goalsView: pathname === "/goals",
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

      if (command === "goals.open") {
        if (!goalsEnabled) {
          return;
        }
        event.preventDefault();
        event.stopPropagation();
        void navigate({ to: "/goals", search: {} });
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
    goalsEnabled,
    handleNewThread,
    keybindings,
    navigate,
    onSearchOpen,
    pathname,
    requestProjectAdd,
    terminalOpen,
    toggleSidebar,
  ]);

  return null;
}

function AppSidebarContent({ children }: { children: ReactNode }) {
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
        "flex min-h-0 min-w-0 flex-1 flex-col",
        showCurvedSidebarEdge ? "bg-transparent" : "bg-background",
      )}
      style={titlebarStyle}
    >
      <div
        className={cn(
          "relative z-10 flex min-h-0 min-w-0 flex-1 flex-col bg-background",
          showCurvedSidebarEdge &&
            "-ml-px overflow-hidden rounded-l-[var(--app-sidebar-shell-radius)]",
        )}
        data-app-chat-shell-with-sidebar={showCurvedSidebarEdge || undefined}
        data-app-modal-blur-surface
      >
        {children}
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
  const { sidebarTranslucent } = useSettings();
  const { open: commandKOpen, setOpen: setCommandKOpen } = useCommandK();
  const openCommandK = useCallback(() => {
    setCommandKOpen(true);
  }, [setCommandKOpen]);
  const translucent = isElectron && sidebarTranslucent;
  useSidebarTranslucency(translucent);

  useEffect(() => {
    const onMenuAction = window.desktopBridge?.onMenuAction;
    if (typeof onMenuAction !== "function") {
      return;
    }

    const unsubscribe = onMenuAction((action) => {
      if (action !== "open-settings") return;
      void navigate({ to: "/settings/general" });
    });

    return () => {
      unsubscribe?.();
    };
  }, [navigate, openCommandK]);

  return (
    <SidebarProvider defaultOpen className="h-dvh">
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
      <AppSidebarContent>{children}</AppSidebarContent>
    </SidebarProvider>
  );
}
