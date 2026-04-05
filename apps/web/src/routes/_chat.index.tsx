import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useRef } from "react";

import { SidebarTrigger } from "../components/ui/sidebar";
import { resolveSidebarNewThreadEnvMode } from "../components/Sidebar.logic";
import { isElectron } from "../env";
import { useHandleNewThread } from "../hooks/useHandleNewThread";
import { useSettings } from "../hooks/useSettings";
import { useStore } from "../store";

function ChatIndexRouteView() {
  const bootstrapComplete = useStore((store) => store.bootstrapComplete);
  const { defaultProjectId, handleNewThread } = useHandleNewThread();
  const appSettings = useSettings();
  const openingProjectIdRef = useRef<string | null>(null);

  useEffect(() => {
    if (!bootstrapComplete || !defaultProjectId) {
      return;
    }
    if (openingProjectIdRef.current === defaultProjectId) {
      return;
    }

    openingProjectIdRef.current = defaultProjectId;
    void handleNewThread(defaultProjectId, {
      envMode: resolveSidebarNewThreadEnvMode({
        defaultEnvMode: appSettings.defaultThreadEnvMode,
      }),
    });
  }, [appSettings.defaultThreadEnvMode, bootstrapComplete, defaultProjectId, handleNewThread]);

  if (!bootstrapComplete || defaultProjectId) {
    return <div className="flex min-h-0 min-w-0 flex-1 bg-background" />;
  }

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col bg-background text-muted-foreground/40">
      {!isElectron && (
        <header className="border-b border-border px-3 py-2 md:hidden">
          <div className="flex items-center gap-2">
            <SidebarTrigger className="size-7 shrink-0" />
            <span className="text-sm font-medium text-foreground">Threads</span>
          </div>
        </header>
      )}

      {isElectron && (
        <div className="drag-region flex h-[52px] shrink-0 items-center border-b border-border px-5">
          <span className="text-xs text-muted-foreground/50">No active thread</span>
        </div>
      )}

      <div className="flex flex-1 items-center justify-center">
        <div className="text-center">
          <p className="text-sm">Select a thread or create a new one to get started.</p>
        </div>
      </div>
    </div>
  );
}

export const Route = createFileRoute("/_chat/")({
  component: ChatIndexRouteView,
});
