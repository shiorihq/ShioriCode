import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useRef } from "react";

import { NoActiveThreadState } from "../components/chat/NoActiveThreadState";
import { resolveSidebarNewThreadEnvMode } from "../components/Sidebar.logic";
import { useHandleNewThread } from "../hooks/useHandleNewThread";
import { useSettings } from "../hooks/useSettings";
import { useStore } from "../store";

function ChatIndexRouteView() {
  const bootstrapComplete = useStore((store) => store.bootstrapComplete);
  const projects = useStore((store) => store.projects);
  const search = Route.useSearch();
  const { defaultProjectId, handleNewThread } = useHandleNewThread();
  const appSettings = useSettings();
  const openingProjectIdRef = useRef<string | null>(null);

  useEffect(() => {
    if (!bootstrapComplete) {
      return;
    }
    const requestedProjectId = search.project
      ? projects.find((project) => project.id === search.project)?.id
      : undefined;
    if (search.project && !requestedProjectId) {
      return;
    }
    const projectId = requestedProjectId ?? defaultProjectId;
    if (!projectId || openingProjectIdRef.current === projectId) {
      return;
    }

    openingProjectIdRef.current = projectId;
    void handleNewThread(projectId, {
      envMode: resolveSidebarNewThreadEnvMode({
        defaultEnvMode: appSettings.defaultThreadEnvMode,
      }),
    });
  }, [
    appSettings.defaultThreadEnvMode,
    bootstrapComplete,
    defaultProjectId,
    handleNewThread,
    projects,
    search.project,
  ]);

  if (!bootstrapComplete || defaultProjectId) {
    return <div className="flex min-h-0 min-w-0 flex-1 bg-background" />;
  }

  return <NoActiveThreadState />;
}

export const Route = createFileRoute("/_chat/")({
  validateSearch: (search: Record<string, unknown>): { project?: string } =>
    typeof search.project === "string" && search.project.length > 0
      ? { project: search.project }
      : {},
  component: ChatIndexRouteView,
});
