import { useEffect, type ReactNode } from "react";
import { useNavigate } from "@tanstack/react-router";
import { useServerKeybindings } from "~/rpc/serverState";
import { resolveShortcutCommand } from "~/keybindings";
import { useDesktopWindowControlsInset } from "~/hooks/useDesktopWindowControlsInset";
import { isTerminalFocused } from "~/lib/terminalFocus";
import { useTerminalStateStore } from "~/terminalStateStore";
import { cn, isMacPlatform } from "~/lib/utils";
import { isElectron } from "~/env";
import { useSettings } from "~/hooks/useSettings";

import ThreadSidebar from "./Sidebar";
import { CommandKModal, useCommandK } from "./CommandKModal";
import { Sidebar, SidebarProvider, SidebarRail, useSidebar } from "./ui/sidebar";

const THREAD_SIDEBAR_WIDTH_STORAGE_KEY = "chat_thread_sidebar_width";
const THREAD_SIDEBAR_MIN_WIDTH = 13 * 16;
const THREAD_MAIN_CONTENT_MIN_WIDTH = 40 * 16;

function AppSidebarKeyboardShortcuts() {
  const { toggleSidebar } = useSidebar();
  const keybindings = useServerKeybindings();
  const terminalOpen = useTerminalStateStore((state) =>
    Object.values(state.terminalStateByThreadId).some(
      (terminalState) => terminalState.terminalOpen,
    ),
  );

  useEffect(() => {
    const onWindowKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented) {
        return;
      }

      const command = resolveShortcutCommand(event, keybindings, {
        context: {
          terminalFocus: isTerminalFocused(),
          terminalOpen,
        },
      });
      if (command !== "sidebar.toggle") {
        return;
      }

      event.preventDefault();
      event.stopPropagation();
      toggleSidebar();
    };

    window.addEventListener("keydown", onWindowKeyDown);
    return () => {
      window.removeEventListener("keydown", onWindowKeyDown);
    };
  }, [keybindings, terminalOpen, toggleSidebar]);

  return null;
}

function AppSidebarContent({ children }: { children: ReactNode }) {
  const { open: sidebarOpen } = useSidebar();
  const macWindowControlsInset = useDesktopWindowControlsInset();
  const applyClosedSidebarMacPadding =
    isElectron && isMacPlatform(navigator.platform) && !sidebarOpen;

  return (
    <div
      className={cn("flex min-h-0 min-w-0 flex-1 flex-col")}
      style={
        applyClosedSidebarMacPadding ? { paddingLeft: `${macWindowControlsInset}px` } : undefined
      }
    >
      {children}
    </div>
  );
}

function useSidebarTranslucency(enabled: boolean) {
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
        data-translucent={translucent || undefined}
        className={cn(
          "border-r border-border text-foreground",
          translucent ? "bg-transparent" : "bg-card",
        )}
        resizable={{
          minWidth: THREAD_SIDEBAR_MIN_WIDTH,
          shouldAcceptWidth: ({ nextWidth, wrapper }) =>
            wrapper.clientWidth - nextWidth >= THREAD_MAIN_CONTENT_MIN_WIDTH,
          storageKey: THREAD_SIDEBAR_WIDTH_STORAGE_KEY,
        }}
      >
        <ThreadSidebar />
        <SidebarRail />
      </Sidebar>
      <AppSidebarContent>{children}</AppSidebarContent>
    </SidebarProvider>
  );
}
