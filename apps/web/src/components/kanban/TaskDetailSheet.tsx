import { type KanbanItem, type ThreadId } from "contracts";
import { BotIcon, GitPullRequestIcon, PlusIcon, TriangleAlertIcon, XIcon } from "lucide-react";
import { useCallback, useMemo, useState } from "react";

import { Button } from "~/components/ui/button";
import { Dialog, DialogPanel, DialogPopup, DialogTitle } from "~/components/ui/dialog";
import { Input } from "~/components/ui/input";
import { Popover, PopoverPopup, PopoverTrigger } from "~/components/ui/popover";
import { cn } from "~/lib/utils";
import { useStore } from "~/store";
import { formatRelativeTimeLabel } from "~/timestampFormat";
import type { Thread } from "~/types";

import {
  ASSIGNEE_ROLE,
  dispatchKanbanCommand,
  newId,
  providerLabel,
  STATUS_THEME,
  STATUSES,
} from "./kanbanShared";

interface TaskDetailSheetProps {
  item: KanbanItem | null;
  onOpenChange: (open: boolean) => void;
}

export function TaskDetailSheet({ item, onOpenChange }: TaskDetailSheetProps) {
  const threads = useStore((state) => state.threads);
  const sidebarThreadsById = useStore((state) => state.sidebarThreadsById);
  const [note, setNote] = useState("");
  const [blockReason, setBlockReason] = useState("");
  const [blockComposerOpen, setBlockComposerOpen] = useState(false);

  const assignableThreads = useMemo(() => {
    if (!item) return [];
    const assignedThreadIds = new Set(
      item.assignees.flatMap((assignee) => (assignee.threadId ? [String(assignee.threadId)] : [])),
    );
    return threads
      .filter((thread) => thread.archivedAt === null)
      .filter((thread) => thread.projectId === item.projectId)
      .filter((thread) => !assignedThreadIds.has(String(thread.id)))
      .toSorted((left, right) => {
        const leftTime = left.updatedAt ?? left.createdAt;
        const rightTime = right.updatedAt ?? right.createdAt;
        return rightTime.localeCompare(leftTime) || left.title.localeCompare(right.title);
      });
  }, [item, threads]);

  const assignThread = useCallback(
    (threadId: ThreadId) => {
      if (!item) return;
      const thread = threads.find((entry) => entry.id === threadId);
      if (!thread) return;
      const now = new Date().toISOString();
      const provider = thread.session?.provider ?? thread.modelSelection.provider;
      void dispatchKanbanCommand({
        type: "kanbanItem.assign",
        commandId: newId("cmd") as never,
        itemId: item.id,
        assignee: {
          id: newId("kanban_assignee") as never,
          provider,
          model: thread.modelSelection.model,
          role: ASSIGNEE_ROLE,
          status: "assigned",
          threadId,
          assignedAt: now,
          updatedAt: now,
        },
        createdAt: now,
      });
    },
    [item, threads],
  );

  const unassignThread = useCallback(
    (assigneeId: KanbanItem["assignees"][number]["id"]) => {
      if (!item) return;
      const now = new Date().toISOString();
      void dispatchKanbanCommand({
        type: "kanbanItem.unassign",
        commandId: newId("cmd") as never,
        itemId: item.id,
        assigneeId,
        createdAt: now,
      });
    },
    [item],
  );

  const addNote = useCallback(() => {
    if (!item || note.trim().length === 0) return;
    const now = new Date().toISOString();
    void dispatchKanbanCommand({
      type: "kanbanItem.note.add",
      commandId: newId("cmd") as never,
      itemId: item.id,
      note: {
        id: newId("kanban_note") as never,
        body: note.trim(),
        authorKind: "client",
        authorName: "You",
        createdAt: now,
      },
      createdAt: now,
    });
    setNote("");
  }, [item, note]);

  const block = useCallback(() => {
    if (!item || blockReason.trim().length === 0) return;
    const now = new Date().toISOString();
    void dispatchKanbanCommand({
      type: "kanbanItem.block",
      commandId: newId("cmd") as never,
      itemId: item.id,
      reason: blockReason.trim(),
      blockedAt: now,
    });
    setBlockReason("");
    setBlockComposerOpen(false);
  }, [blockReason, item]);

  const unblock = useCallback(() => {
    if (!item) return;
    const now = new Date().toISOString();
    void dispatchKanbanCommand({
      type: "kanbanItem.unblock",
      commandId: newId("cmd") as never,
      itemId: item.id,
      unblockedAt: now,
    });
  }, [item]);

  const theme = item ? STATUS_THEME[item.status] : null;
  const statusLabel = item
    ? (STATUSES.find((entry) => entry.status === item.status)?.label ?? item.status)
    : "";
  const description = item?.description.trim() ?? "";

  return (
    <Dialog open={item !== null} onOpenChange={onOpenChange}>
      <DialogPopup
        showCloseButton={false}
        className="max-h-[min(640px,calc(100vh-3rem))] w-full max-w-xl gap-0"
      >
        {item && theme ? (
          <>
            <header className="flex items-start gap-3 px-7 pt-6 pb-2">
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-1.5">
                  <span className={cn("size-1.5 rounded-full", theme.dot)} aria-hidden />
                  <span className={cn("text-[11px] font-medium", theme.text)}>{statusLabel}</span>
                </div>
                <DialogTitle className="mt-1.5 text-balance text-[16px] font-semibold leading-snug">
                  {item.title}
                </DialogTitle>
              </div>
              <Button
                type="button"
                size="icon-xs"
                variant="ghost"
                aria-label="Close"
                onClick={() => onOpenChange(false)}
                className="-mr-1 shrink-0 text-muted-foreground hover:text-foreground"
              >
                <XIcon className="size-3.5" aria-hidden />
              </Button>
            </header>

            <DialogPanel className="flex min-h-0 flex-col gap-5 px-7 pt-3 pb-6">
              {description.length > 0 ? (
                <p className="text-pretty whitespace-pre-wrap text-[13.5px] leading-relaxed text-foreground/85">
                  {description}
                </p>
              ) : null}

              {item.pullRequest ? (
                <a
                  href={item.pullRequest.url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="group inline-flex max-w-full items-center gap-2 self-start rounded-md border border-border/55 px-2.5 py-1.5 text-[12.5px] text-foreground transition-colors hover:bg-accent/40"
                >
                  <GitPullRequestIcon
                    className="size-3.5 shrink-0 text-muted-foreground"
                    aria-hidden
                  />
                  <span className="truncate">{item.pullRequest.title}</span>
                  <span className="shrink-0 tabular-nums text-muted-foreground/65">
                    #{item.pullRequest.number}
                  </span>
                </a>
              ) : null}

              <Group
                label="Threads"
                action={
                  <ThreadAssignTrigger
                    threads={assignableThreads}
                    onAssign={assignThread}
                    hasAssigned={item.assignees.length > 0}
                  />
                }
              >
                {item.assignees.length > 0 ? (
                  <ul className="flex flex-col">
                    {item.assignees.map((assignee) => {
                      const threadSummary = assignee.threadId
                        ? sidebarThreadsById[String(assignee.threadId)]
                        : undefined;
                      return (
                        <li
                          key={assignee.id}
                          className="group/row flex min-w-0 items-center gap-2 border-b border-border/30 py-2 last:border-b-0"
                        >
                          <BotIcon
                            className="size-3.5 shrink-0 text-muted-foreground"
                            aria-hidden
                          />
                          <div className="min-w-0 flex-1">
                            <p className="truncate text-[13px] font-medium text-foreground">
                              {threadSummary?.title ?? "Thread unavailable"}
                            </p>
                            <p className="truncate text-[11px] text-muted-foreground/65">
                              {providerLabel(assignee.provider)}
                              {assignee.model ? ` · ${assignee.model}` : ""}
                            </p>
                          </div>
                          <Button
                            type="button"
                            size="icon-xs"
                            variant="ghost"
                            aria-label="Unassign thread"
                            className="shrink-0 text-muted-foreground opacity-0 transition-opacity group-hover/row:opacity-100 focus-visible:opacity-100"
                            onClick={() => unassignThread(assignee.id)}
                          >
                            <XIcon className="size-3" aria-hidden />
                          </Button>
                        </li>
                      );
                    })}
                  </ul>
                ) : (
                  <p className="text-[12px] text-muted-foreground/55">No threads assigned.</p>
                )}
              </Group>

              {item.blockedReason ? (
                <div className="flex items-start gap-2.5 rounded-md border border-destructive/30 bg-destructive/[0.05] px-3 py-2.5">
                  <TriangleAlertIcon
                    className="mt-[2px] size-3.5 shrink-0 text-destructive"
                    aria-hidden
                  />
                  <div className="min-w-0 flex-1">
                    <p className="text-pretty text-[12.5px] leading-relaxed text-destructive">
                      {item.blockedReason}
                    </p>
                  </div>
                  <Button
                    type="button"
                    size="xs"
                    variant="ghost"
                    onClick={unblock}
                    className="shrink-0"
                  >
                    Clear
                  </Button>
                </div>
              ) : null}

              <Group label="Activity">
                {item.notes.length > 0 ? (
                  <ul className="flex flex-col">
                    {item.notes.map((entry) => (
                      <li key={entry.id} className="border-b border-border/30 py-2 last:border-b-0">
                        <p className="text-pretty text-[12.5px] leading-relaxed text-foreground/85">
                          {entry.body}
                        </p>
                        <p className="mt-0.5 text-[10.5px] text-muted-foreground/60">
                          <span>{entry.authorName ?? entry.authorKind}</span>
                          <span className="px-1">·</span>
                          <span>{formatRelativeTimeLabel(entry.createdAt)}</span>
                        </p>
                      </li>
                    ))}
                  </ul>
                ) : null}
                <Input
                  size="sm"
                  placeholder="Write a note…"
                  value={note}
                  onChange={(event) => setNote(event.currentTarget.value)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter") {
                      event.preventDefault();
                      addNote();
                    }
                  }}
                  className="mt-1.5"
                />
              </Group>
            </DialogPanel>

            {!item.blockedReason ? (
              <footer className="flex items-center gap-3 border-t border-border/50 px-5 py-2">
                {blockComposerOpen ? (
                  <div className="flex w-full items-center gap-2">
                    <Input
                      size="sm"
                      autoFocus
                      placeholder="Reason for blocking"
                      value={blockReason}
                      onChange={(event) => setBlockReason(event.currentTarget.value)}
                      onKeyDown={(event) => {
                        if (event.key === "Enter") {
                          event.preventDefault();
                          block();
                        }
                        if (event.key === "Escape") {
                          event.preventDefault();
                          setBlockComposerOpen(false);
                          setBlockReason("");
                        }
                      }}
                    />
                    <Button
                      type="button"
                      size="sm"
                      variant="outline"
                      onClick={() => {
                        setBlockComposerOpen(false);
                        setBlockReason("");
                      }}
                    >
                      Cancel
                    </Button>
                    <Button
                      type="button"
                      size="sm"
                      variant="destructive-outline"
                      disabled={blockReason.trim().length === 0}
                      onClick={block}
                    >
                      Block
                    </Button>
                  </div>
                ) : (
                  <>
                    <Button
                      type="button"
                      size="xs"
                      variant="ghost"
                      className="text-muted-foreground hover:text-foreground"
                      onClick={() => setBlockComposerOpen(true)}
                    >
                      <TriangleAlertIcon className="size-3" aria-hidden />
                      Block task
                    </Button>
                    <span className="ml-auto text-[10.5px] text-muted-foreground/60">
                      Created {formatRelativeTimeLabel(item.createdAt)}
                    </span>
                  </>
                )}
              </footer>
            ) : null}
          </>
        ) : null}
      </DialogPopup>
    </Dialog>
  );
}

function Group({
  label,
  action,
  children,
}: {
  label: string;
  action?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <section className="flex flex-col gap-1.5">
      <div className="flex items-center justify-between">
        <p className="text-[11px] font-medium text-muted-foreground/70">{label}</p>
        {action}
      </div>
      {children}
    </section>
  );
}

function ThreadAssignTrigger({
  threads,
  onAssign,
  hasAssigned,
}: {
  threads: readonly Thread[];
  onAssign: (threadId: ThreadId) => void;
  hasAssigned: boolean;
}) {
  const [query, setQuery] = useState("");

  const filtered = useMemo(() => {
    const trimmed = query.trim().toLowerCase();
    if (trimmed.length === 0) return threads;
    return threads.filter((thread) => {
      const provider = thread.session?.provider ?? thread.modelSelection.provider;
      const haystack =
        `${thread.title} ${providerLabel(provider)} ${thread.modelSelection.model ?? ""}`.toLowerCase();
      return haystack.includes(trimmed);
    });
  }, [query, threads]);

  if (threads.length === 0) {
    return (
      <span className="text-[10.5px] text-muted-foreground/55">
        {hasAssigned ? "No more available" : "No threads in project"}
      </span>
    );
  }

  return (
    <Popover
      onOpenChange={(open) => {
        if (!open) setQuery("");
      }}
    >
      <PopoverTrigger
        render={
          <Button
            type="button"
            size="xs"
            variant="ghost"
            aria-label="Assign thread"
            className="-mr-1 text-muted-foreground hover:text-foreground"
          />
        }
      >
        <PlusIcon className="size-3" aria-hidden />
        {hasAssigned ? "Assign another" : "Assign thread"}
      </PopoverTrigger>
      <PopoverPopup align="end" sideOffset={6} className="w-[18rem]">
        <div className="flex flex-col gap-2">
          <Input
            size="sm"
            autoFocus
            placeholder="Search threads…"
            value={query}
            onChange={(event) => setQuery(event.currentTarget.value)}
            aria-label="Search threads"
          />
          {filtered.length === 0 ? (
            <p className="py-2 text-center text-[12px] text-muted-foreground/60">No matches.</p>
          ) : (
            <ul className="-mx-2 flex max-h-[15rem] flex-col overflow-y-auto">
              {filtered.map((thread) => {
                const provider = thread.session?.provider ?? thread.modelSelection.provider;
                return (
                  <li key={thread.id}>
                    <button
                      type="button"
                      onClick={() => onAssign(thread.id)}
                      className="flex w-full min-w-0 flex-col gap-0.5 px-3 py-1.5 text-left transition-colors hover:bg-accent/60"
                    >
                      <span className="truncate text-[12.5px] font-medium text-foreground">
                        {thread.title}
                      </span>
                      <span className="truncate text-[10.5px] text-muted-foreground/65">
                        {providerLabel(provider)}
                        {thread.modelSelection.model ? ` · ${thread.modelSelection.model}` : ""}
                      </span>
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      </PopoverPopup>
    </Popover>
  );
}
