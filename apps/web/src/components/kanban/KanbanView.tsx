import type { ProjectId } from "contracts";
import { useNavigate } from "@tanstack/react-router";
import { IconCircleDottedOutline24 as CircleDotDashedIcon } from "nucleo-core-outline-24";
import { useCallback, useEffect, useRef, useState } from "react";

import { KanbanHeaderControls } from "~/components/kanban/KanbanHeaderControls";
import { PrKanbanBoard, type KanbanAgentFilter } from "~/components/kanban/PrKanbanBoard";
import { Button } from "~/components/ui/button";
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "~/components/ui/empty";
import { SidebarInset } from "~/components/ui/sidebar";
import { isElectron } from "~/env";
import { resolveShortcutCommand } from "~/keybindings";
import { isInputFocused } from "~/lib/inputFocus";
import { cn } from "~/lib/utils";
import { useServerKeybindings } from "~/rpc/serverState";
import { useStore } from "~/store";
import { useUiStateStore } from "~/uiStateStore";

interface KanbanViewProps {
  projectId: string | null;
}

const ALL_PROJECTS_VALUE = "__all__";

export function KanbanView({ projectId }: KanbanViewProps) {
  const projects = useStore((store) => store.projects);
  const requestProjectAdd = useUiStateStore((state) => state.requestProjectAdd);
  const navigate = useNavigate();
  const keybindings = useServerKeybindings();

  const activeProjectId: ProjectId | null = projectId ? (projectId as ProjectId) : null;

  const [searchQuery, setSearchQuery] = useState("");
  const [agentFilter, setAgentFilter] = useState<KanbanAgentFilter>("any");
  const [blockedOnly, setBlockedOnly] = useState(false);
  const [composerOpen, setComposerOpen] = useState(false);
  const [filtersOpen, setFiltersOpen] = useState(false);
  const searchInputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    if (projects.length === 0) return;
    const onKeyDown = (event: KeyboardEvent) => {
      const command = resolveShortcutCommand(event, keybindings, {
        context: { kanbanView: true, inputFocus: isInputFocused() },
      });
      if (command === "kanban.newTask") {
        event.preventDefault();
        event.stopPropagation();
        setComposerOpen(true);
        return;
      }
      if (command === "kanban.search") {
        event.preventDefault();
        event.stopPropagation();
        setFiltersOpen(true);
        // Popover mounts the input on next frame; focus then.
        requestAnimationFrame(() => {
          searchInputRef.current?.focus();
          searchInputRef.current?.select();
        });
        return;
      }
    };
    window.addEventListener("keydown", onKeyDown, { capture: true });
    return () => window.removeEventListener("keydown", onKeyDown, { capture: true });
  }, [keybindings, projects.length]);

  const clearFilters = useCallback(() => {
    setSearchQuery("");
    setAgentFilter("any");
    setBlockedOnly(false);
  }, []);

  const changeProject = useCallback(
    (next: string) => {
      if (next === ALL_PROJECTS_VALUE) {
        void navigate({ to: "/goals", search: {} });
        return;
      }
      void navigate({ to: "/goals", search: { projectId: next } });
    },
    [navigate],
  );

  const projectSelect =
    projects.length > 0 ? (
      <select
        aria-label="Filter by project"
        className={cn(
          "h-7 rounded-md border border-border/60 bg-background px-2 text-[12px] text-foreground",
          "outline-hidden focus-visible:ring-1 focus-visible:ring-ring",
        )}
        value={activeProjectId ?? ALL_PROJECTS_VALUE}
        onChange={(event) => changeProject(event.currentTarget.value)}
      >
        <option value={ALL_PROJECTS_VALUE}>All projects</option>
        {projects.map((project) => (
          <option key={project.id} value={project.id}>
            {project.name}
          </option>
        ))}
      </select>
    ) : null;

  const heading = (
    <div className="app-titlebar-window-controls-inset flex h-full items-center gap-3 px-4 [--app-titlebar-base-left-padding:1rem]">
      <div className="flex min-w-0 items-center gap-2">
        <CircleDotDashedIcon className="size-4 shrink-0 text-muted-foreground" aria-hidden />
        <h1 className="truncate text-[14px] font-semibold tracking-tight text-foreground">Goals</h1>
      </div>
      {projectSelect}
      <div className="ml-auto flex items-center">
        {projects.length > 0 ? (
          <KanbanHeaderControls
            searchQuery={searchQuery}
            onSearchQueryChange={setSearchQuery}
            agentFilter={agentFilter}
            onAgentFilterChange={setAgentFilter}
            blockedOnly={blockedOnly}
            onBlockedOnlyChange={setBlockedOnly}
            onClearFilters={clearFilters}
            canCreate={projects.length > 0}
            onNewTask={() => setComposerOpen(true)}
            filtersOpen={filtersOpen}
            onFiltersOpenChange={setFiltersOpen}
            searchInputRef={searchInputRef}
          />
        ) : null}
      </div>
    </div>
  );

  return (
    <SidebarInset className="h-dvh min-h-0 overflow-hidden overscroll-y-none bg-background text-foreground">
      <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
        {isElectron ? (
          <div className="drag-region flex h-[52px] shrink-0 items-center border-b border-border/40">
            {heading}
          </div>
        ) : (
          <header className="flex h-12 shrink-0 items-center border-b border-border/40">
            {heading}
          </header>
        )}
        <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
          {projects.length === 0 ? (
            <div className="flex flex-1 items-center justify-center p-6">
              <Empty>
                <EmptyHeader>
                  <EmptyMedia variant="icon">
                    <CircleDotDashedIcon />
                  </EmptyMedia>
                  <EmptyTitle className="text-balance">No projects registered</EmptyTitle>
                  <EmptyDescription className="text-pretty">
                    Open a project in ShioriCode to start turning goals into plans and runs.
                  </EmptyDescription>
                </EmptyHeader>
                <EmptyContent>
                  <Button onClick={requestProjectAdd}>Open Folder</Button>
                </EmptyContent>
              </Empty>
            </div>
          ) : (
            <PrKanbanBoard
              projectId={activeProjectId}
              pullRequest={null}
              searchQuery={searchQuery}
              agentFilter={agentFilter}
              blockedOnly={blockedOnly}
              composerOpen={composerOpen}
              onComposerOpenChange={setComposerOpen}
            />
          )}
        </div>
      </div>
    </SidebarInset>
  );
}
