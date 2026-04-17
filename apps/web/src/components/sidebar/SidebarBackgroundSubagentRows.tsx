import { type ThreadId } from "contracts";
import { memo, useMemo } from "react";

import { deriveWorkLogEntries } from "../../session-logic";
import { useThreadById } from "../../storeSelectors";
import {
  deriveBackgroundSubagentRows,
  type CodexBackgroundSubagentRow,
} from "../chat/subagentDetail";
import { SidebarMenuSub, SidebarMenuSubItem } from "../ui/sidebar";
import { cn } from "~/lib/utils";

const SIDEBAR_SUBAGENT_NAME_CLASSES = [
  "text-orange-500",
  "text-emerald-500",
  "text-sky-500",
  "text-fuchsia-500",
  "text-amber-500",
  "text-lime-500",
] as const;

function sidebarSubagentNameClass(index: number): string {
  return SIDEBAR_SUBAGENT_NAME_CLASSES[index % SIDEBAR_SUBAGENT_NAME_CLASSES.length]!;
}

export const SidebarBackgroundSubagentRowsView = memo(
  function SidebarBackgroundSubagentRowsView(props: {
    threadId: ThreadId;
    rows: readonly CodexBackgroundSubagentRow[];
  }) {
    if (props.rows.length === 0) {
      return null;
    }

    return (
      <SidebarMenuSub className="mx-0 my-0 w-full translate-x-0 gap-0 overflow-hidden border-l-0 px-0 py-0">
        {props.rows.map((row, index) => {
          const statusLabel = row.status === "active" ? "is working" : "is awaiting instruction";
          return (
            <SidebarMenuSubItem
              key={row.id}
              className="w-full"
              data-thread-selection-safe
              title={row.instruction ?? undefined}
            >
              <div className="flex w-full items-center gap-1.5 py-0.5 pr-2 pl-9 text-left text-sm text-muted-foreground/70">
                <span className="inline-flex w-3 shrink-0 items-center justify-center">
                  <span
                    className={cn(
                      "size-1.5 rounded-full bg-current opacity-60",
                      row.status === "active" && "animate-pulse",
                    )}
                    aria-hidden="true"
                  />
                </span>
                <span className="min-w-0 truncate">
                  <span className={cn("font-medium", sidebarSubagentNameClass(index))}>
                    {row.displayName}
                  </span>
                  {row.agentRole && <span className="text-foreground/45"> ({row.agentRole})</span>}
                  <span
                    className={cn(
                      "text-foreground/55",
                      row.status === "active" && "shimmer shimmer-spread-200",
                    )}
                  >
                    {" "}
                    {statusLabel}
                  </span>
                </span>
              </div>
            </SidebarMenuSubItem>
          );
        })}
      </SidebarMenuSub>
    );
  },
);

export function useSidebarBackgroundSubagentRows(
  threadId: ThreadId,
): readonly CodexBackgroundSubagentRow[] {
  const thread = useThreadById(threadId);
  return useMemo(() => {
    if (!thread) {
      return [];
    }

    const provider = thread.session?.provider ?? thread.modelSelection.provider;

    const workEntries = deriveWorkLogEntries(thread.activities, undefined);
    return deriveBackgroundSubagentRows({
      provider,
      workEntries,
      activities: thread.activities,
    });
  }, [thread]);
}

export const SidebarBackgroundSubagentRows = memo(function SidebarBackgroundSubagentRows(props: {
  threadId: ThreadId;
}) {
  const rows = useSidebarBackgroundSubagentRows(props.threadId);
  return <SidebarBackgroundSubagentRowsView threadId={props.threadId} rows={rows} />;
});
