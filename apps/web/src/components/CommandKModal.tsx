import { useCallback, useEffect, useMemo, useState } from "react";
import { useNavigate } from "@tanstack/react-router";
import {
  IconArrowDownOutline24 as ArrowDownIcon,
  IconArrowUpOutline24 as ArrowUpIcon,
  IconBranchMergeOutline24 as DiffIcon,
  IconFolderOpenOutline24 as FolderOpenIcon,
  IconMessageOutline24 as MessageSquareIcon,
  IconLayoutBottomOutline24 as PanelBottomIcon,
  IconLayoutLeftOutline24 as PanelLeftIcon,
  IconGearOutline24 as SettingsIcon,
  IconComposeOutline24 as NewThreadIcon,
} from "nucleo-core-outline-24";
import { type KeybindingCommand, type ThreadId } from "contracts";

import {
  Command,
  CommandCollection,
  CommandDialog,
  CommandDialogPopup,
  CommandGroup,
  CommandGroupLabel,
  CommandInput,
  CommandItem,
  CommandList,
  CommandPanel,
  CommandShortcut,
} from "~/components/ui/command";
import { useStore } from "~/store";
import { shortcutLabelForCommand } from "~/keybindings";
import { useServerKeybindings } from "~/rpc/serverState";
import { useSidebar } from "~/components/ui/sidebar";
import { useHandleNewThread } from "~/hooks/useHandleNewThread";
import {
  getOrderedActiveSidebarThreadIds,
  resolveAdjacentThreadId,
  resolveSidebarNewThreadEnvMode,
} from "~/components/Sidebar.logic";
import { useSettings } from "~/hooks/useSettings";
import { useUiStateStore } from "~/uiStateStore";

// ── Types ────────────────────────────────────────────────────────────

interface CommandKModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

interface CommandEntry {
  id: string;
  label: string;
  icon: React.ReactNode;
  shortcutCommand?: KeybindingCommand;
  onSelect: () => void;
}

interface CommandGroupDef {
  label: string;
  items: CommandEntry[];
}

// ── Component ────────────────────────────────────────────────────────

export function CommandKModal({ open, onOpenChange }: CommandKModalProps) {
  const navigate = useNavigate();
  const keybindings = useServerKeybindings();
  const { toggleSidebar } = useSidebar();
  const [query, setQuery] = useState("");
  const projectOrder = useUiStateStore((store) => store.projectOrder);
  const { handleNewThread, activeThread, activeDraftThread, defaultProjectId } =
    useHandleNewThread();
  const appSettings = useSettings();
  const requestProjectAdd = useUiStateStore((store) => store.requestProjectAdd);
  const projects = useStore((store) => store.projects);
  const threadIdsByProjectId = useStore((store) => store.threadIdsByProjectId);

  const sidebarThreadsById = useStore((s) => s.sidebarThreadsById);

  const threads = useMemo(
    () => Object.values(sidebarThreadsById).filter((t) => t.archivedAt === null),
    [sidebarThreadsById],
  );

  const close = useCallback(() => onOpenChange(false), [onOpenChange]);

  useEffect(() => {
    if (!open) {
      setQuery("");
    }
  }, [open]);

  const navigateToThread = useCallback(
    (threadId: ThreadId) => {
      close();
      void navigate({ to: "/$threadId", params: { threadId } });
    },
    [close, navigate],
  );

  const orderedActiveThreadIds = useMemo(
    () =>
      getOrderedActiveSidebarThreadIds({
        projects,
        threadsById: sidebarThreadsById,
        threadIdsByProjectId,
        preferredProjectIds: projectOrder,
        projectSortOrder: appSettings.sidebarProjectSortOrder,
        threadSortOrder: appSettings.sidebarThreadSortOrder,
      }),
    [
      appSettings.sidebarProjectSortOrder,
      appSettings.sidebarThreadSortOrder,
      sidebarThreadsById,
      threadIdsByProjectId,
      projectOrder,
      projects,
    ],
  );

  const navigateAdjacentThread = useCallback(
    (direction: "previous" | "next") => {
      const targetThreadId = resolveAdjacentThreadId({
        threadIds: orderedActiveThreadIds,
        currentThreadId: activeThread?.id ?? null,
        direction,
      });
      if (!targetThreadId) {
        close();
        return;
      }
      navigateToThread(targetThreadId);
    },
    [activeThread?.id, close, navigateToThread, orderedActiveThreadIds],
  );

  const commandGroups = useMemo<CommandGroupDef[]>(() => {
    const groups: CommandGroupDef[] = [];

    groups.push({
      label: "Suggested",
      items: [
        {
          id: "new-thread",
          label: "New Thread",
          icon: <NewThreadIcon className="size-4" />,
          shortcutCommand: "chat.new",
          onSelect: () => {
            close();
            const projectId =
              activeThread?.projectId ?? activeDraftThread?.projectId ?? defaultProjectId;
            if (!projectId) return;
            void handleNewThread(projectId, {
              envMode: resolveSidebarNewThreadEnvMode({
                defaultEnvMode: appSettings.defaultThreadEnvMode,
              }),
            });
          },
        },
        {
          id: "open-folder",
          label: "Open folder",
          icon: <FolderOpenIcon className="size-4" />,
          shortcutCommand: "project.add",
          onSelect: () => {
            close();
            requestProjectAdd();
          },
        },
        {
          id: "settings",
          label: "Settings",
          icon: <SettingsIcon className="size-4" />,
          onSelect: () => {
            close();
            void navigate({ to: "/settings" });
          },
        },
      ],
    });

    groups.push({
      label: "Navigation",
      items: [
        {
          id: "nav-prev-thread",
          label: "Previous thread",
          icon: <ArrowUpIcon className="size-4" />,
          shortcutCommand: "thread.previous",
          onSelect: () => navigateAdjacentThread("previous"),
        },
        {
          id: "nav-next-thread",
          label: "Next thread",
          icon: <ArrowDownIcon className="size-4" />,
          shortcutCommand: "thread.next",
          onSelect: () => navigateAdjacentThread("next"),
        },
      ],
    });

    groups.push({
      label: "Panels",
      items: [
        {
          id: "toggle-sidebar",
          label: "Toggle sidebar",
          icon: <PanelLeftIcon className="size-4" />,
          shortcutCommand: "sidebar.toggle",
          onSelect: () => {
            close();
            toggleSidebar();
          },
        },
        {
          id: "toggle-terminal",
          label: "Toggle terminal",
          icon: <PanelBottomIcon className="size-4" />,
          shortcutCommand: "terminal.toggle",
          onSelect: close,
        },
        {
          id: "toggle-diff",
          label: "Toggle diff panel",
          icon: <DiffIcon className="size-4" />,
          shortcutCommand: "diff.toggle",
          onSelect: close,
        },
      ],
    });

    if (threads.length > 0) {
      groups.push({
        label: "Threads",
        items: threads.map((thread) => ({
          id: `thread-${thread.id}`,
          label: thread.title || "Untitled thread",
          icon: <MessageSquareIcon className="size-4" />,
          onSelect: () => navigateToThread(thread.id),
        })),
      });
    }

    return groups;
  }, [
    activeThread,
    activeDraftThread,
    appSettings.defaultThreadEnvMode,
    close,
    defaultProjectId,
    handleNewThread,
    navigate,
    navigateAdjacentThread,
    navigateToThread,
    requestProjectAdd,
    threads,
    toggleSidebar,
  ]);

  return (
    <CommandDialog open={open} onOpenChange={onOpenChange}>
      <CommandDialogPopup>
        <Command
          items={commandGroups}
          itemToStringValue={(item: unknown) =>
            typeof item === "object" &&
            item !== null &&
            "label" in item &&
            typeof item.label === "string"
              ? item.label
              : ""
          }
          mode="list"
          value={query}
          onValueChange={(value: string) => {
            setQuery(value);
          }}
        >
          <CommandInput placeholder="Type command or search threads" />
          <CommandPanel>
            <CommandList>
              {(group: CommandGroupDef) => (
                <CommandGroup key={group.label} items={group.items}>
                  <CommandGroupLabel>{group.label}</CommandGroupLabel>
                  <CommandCollection>
                    {(item: CommandEntry) => (
                      <CommandItem
                        key={item.id}
                        onClick={() => {
                          item.onSelect();
                        }}
                        value={item}
                      >
                        <span className="flex items-center gap-2.5">
                          <span className="text-muted-foreground">{item.icon}</span>
                          <span>{item.label}</span>
                        </span>
                        {item.shortcutCommand && (
                          <CommandShortcut>
                            {shortcutLabelForCommand(keybindings, item.shortcutCommand)}
                          </CommandShortcut>
                        )}
                      </CommandItem>
                    )}
                  </CommandCollection>
                </CommandGroup>
              )}
            </CommandList>
          </CommandPanel>
        </Command>
      </CommandDialogPopup>
    </CommandDialog>
  );
}

// ── Hook: useCommandK ────────────────────────────────────────────────

export function useCommandK() {
  const [open, setOpen] = useState(false);
  return { open, setOpen };
}
