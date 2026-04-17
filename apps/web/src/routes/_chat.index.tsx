import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useRef } from "react";

import { NoActiveThreadState } from "../components/chat/NoActiveThreadState";
import { resolveSidebarNewThreadEnvMode } from "../components/Sidebar.logic";
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

  return <NoActiveThreadState />;
}

export const Route = createFileRoute("/_chat/")({
  component: ChatIndexRouteView,
});
