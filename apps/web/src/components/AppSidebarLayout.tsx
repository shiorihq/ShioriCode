import { useEffect, type ReactNode } from "react";
import { useNavigate } from "@tanstack/react-router";
import { useServerKeybindings } from "~/rpc/serverState";
import { useDesktopWindowControlsInset } from "~/hooks/useDesktopWindowControlsInset";
import { isTerminalFocused } from "~/lib/terminalFocus";
import { useTerminalStateStore } from "~/terminalStateStore";
import { useUiStateStore } from "~/uiStateStore";
import { cn, isMacPlatform } from "~/lib/utils";
import { isElectron } from "~/env";
import { useSettings } from "~/hooks/useSettings";

import ThreadSidebar from "./Sidebar";
import { resolveAppSidebarShortcutCommand } from "./AppSidebarLayout.logic";
import { CommandKModal, useCommandK } from "./CommandKModal";
import { Sidebar, SidebarProvider, SidebarRail, useSidebar } from "./ui/sidebar";

const THREAD_SIDEBAR_WIDTH_STORAGE_KEY = "chat_thread_sidebar_width";
const THREAD_SIDEBAR_MIN_WIDTH = 13 * 16;
const THREAD_MAIN_CONTENT_MIN_WIDTH = 40 * 16;

function AppSidebarKeyboardShortcuts() {
  const { toggleSidebar } = useSidebar();
  const keybindings = useServerKeybindings();
  const navigate = useNavigate();
  const requestProjectAdd = useUiStateStore((state) => state.requestProjectAdd);
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
  }, [keybindings, navigate, requestProjectAdd, terminalOpen, toggleSidebar]);

  return null;
}

function AppSidebarContent({ children }: { children: ReactNode }) {
  const { isMobile, open: sidebarOpen } = useSidebar();
  const macWindowControlsInset = useDesktopWindowControlsInset();
  const applyClosedSidebarMacPadding =
    isElectron && isMacPlatform(navigator.platform) && !sidebarOpen;
  const showCurvedSidebarEdge = sidebarOpen && !isMobile;

  return (
    <div
      className={cn(
        "flex min-h-0 min-w-0 flex-1 flex-col",
        showCurvedSidebarEdge ? "bg-transparent" : "bg-background",
      )}
      style={
        applyClosedSidebarMacPadding ? { paddingLeft: `${macWindowControlsInset}px` } : undefined
      }
    >
      <div
        className={cn(
          "relative z-10 flex min-h-0 min-w-0 flex-1 flex-col bg-background",
          showCurvedSidebarEdge &&
            "-ml-px overflow-hidden rounded-tl-[var(--app-sidebar-shell-radius)]",
        )}
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
  const translucent = isElectron && sidebarTranslucent;
  useSidebarTranslucency(translucent);

  useEffect(() => {
    const onMenuAction = window.desktopBridge?.onMenuAction;
    if (typeof onMenuAction !== "function") {
      return;
    }

    const unsubscribe = onMenuAction((action) => {
      if (action !== "open-settings") return;
      void navigate({ to: "/settings" });
    });

    return () => {
      unsubscribe?.();
    };
  }, [navigate]);

  return (
    <SidebarProvider defaultOpen className="h-dvh">
      <AppSidebarKeyboardShortcuts />
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
        <ThreadSidebar onSearchClick={() => setCommandKOpen(true)} />
        <SidebarRail />
      </Sidebar>
      <AppSidebarContent>{children}</AppSidebarContent>
    </SidebarProvider>
  );
}
