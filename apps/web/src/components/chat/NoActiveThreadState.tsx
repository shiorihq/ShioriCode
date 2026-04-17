import { FolderOpenIcon, SquarePenIcon } from "lucide-react";
import { Link } from "@tanstack/react-router";

import { useSettings } from "../../hooks/useSettings";
import { useHandleNewThread } from "../../hooks/useHandleNewThread";
import { useUiStateStore } from "../../uiStateStore";
import { useStore } from "../../store";
import { isElectron } from "../../env";
import { resolveSidebarNewThreadEnvMode } from "../Sidebar.logic";
import { Button } from "../ui/button";
import { SidebarTrigger } from "../ui/sidebar";
import { sortThreadsForSidebar } from "../Sidebar.logic";
import type { SidebarThreadSortOrder } from "contracts/settings";
import type { Thread } from "../../types";

function RecentThread({ thread }: { thread: Pick<Thread, "id" | "title"> }) {
  return (
    <Link
      to="/$threadId"
      params={{ threadId: thread.id }}
      className="flex items-center gap-2 rounded-md px-3 py-2 text-sm text-foreground transition-colors hover:bg-accent"
    >
      <span className="min-w-0 flex-1 truncate">{thread.title}</span>
    </Link>
  );
}

export function NoActiveThreadState() {
  const { defaultThreadEnvMode } = useSettings();
  const { defaultProjectId, handleNewThread } = useHandleNewThread();
  const requestProjectAdd = useUiStateStore((state) => state.requestProjectAdd);
  const threadsById = useStore((store) => store.sidebarThreadsById);
  const threadIdsByProjectId = useStore((store) => store.threadIdsByProjectId);
  const sidebarThreadSortOrder = useSettings().sidebarThreadSortOrder;

  const recentThreads = (() => {
    if (!defaultProjectId) return [];
    const threadIds = threadIdsByProjectId[defaultProjectId] ?? [];
    const threads = threadIds
      .map((id) => threadsById[id])
      .filter((t): t is NonNullable<typeof t> => t != null && t.archivedAt === null);
    const sorted = sortThreadsForSidebar(threads, sidebarThreadSortOrder as SidebarThreadSortOrder);
    return sorted.slice(0, 5);
  })();

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
      <div className="flex flex-1 items-center justify-center p-6">
        <div className="max-w-sm text-center">
          {defaultProjectId ? (
            recentThreads.length > 0 ? (
              <>
                <p className="text-sm text-foreground">Pick up where you left off</p>
                <div className="mt-4 flex flex-col gap-0.5 text-left">
                  {recentThreads.map((thread) => (
                    <RecentThread key={thread.id} thread={thread} />
                  ))}
                </div>
                <div className="mt-4 flex flex-wrap items-center justify-center gap-2">
                  <Button
                    onClick={() =>
                      void handleNewThread(defaultProjectId, {
                        envMode: resolveSidebarNewThreadEnvMode({
                          defaultEnvMode: defaultThreadEnvMode,
                        }),
                      })
                    }
                  >
                    <SquarePenIcon className="size-4" />
                    New Thread
                  </Button>
                  <Button variant="outline" onClick={requestProjectAdd}>
                    <FolderOpenIcon className="size-4" />
                    Open Another Folder
                  </Button>
                </div>
              </>
            ) : (
              <>
                <p className="text-sm text-foreground">
                  Start a new thread to begin working in this project.
                </p>
                <p className="mt-2 text-sm text-muted-foreground">
                  You can also pick an existing thread from the sidebar at any time.
                </p>
                <div className="mt-5 flex flex-wrap items-center justify-center gap-2">
                  <Button
                    onClick={() =>
                      void handleNewThread(defaultProjectId, {
                        envMode: resolveSidebarNewThreadEnvMode({
                          defaultEnvMode: defaultThreadEnvMode,
                        }),
                      })
                    }
                  >
                    <SquarePenIcon className="size-4" />
                    New Thread
                  </Button>
                  <Button variant="outline" onClick={requestProjectAdd}>
                    <FolderOpenIcon className="size-4" />
                    Open Another Folder
                  </Button>
                </div>
              </>
            )
          ) : (
            <>
              <p className="text-sm text-foreground">
                Add a project folder to start your first thread.
              </p>
              <p className="mt-2 text-sm text-muted-foreground">
                Once a project is open, ShioriCode can create threads, pull requests, and
                workspace-aware drafts for it.
              </p>
              <div className="mt-5 flex flex-wrap items-center justify-center gap-2">
                <Button onClick={requestProjectAdd}>
                  <FolderOpenIcon className="size-4" />
                  Open Folder
                </Button>
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
