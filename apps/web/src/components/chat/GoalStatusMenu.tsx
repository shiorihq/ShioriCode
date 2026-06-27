import type { ThreadGoal, ThreadGoalStatus } from "contracts";
import { memo, useState } from "react";
import {
  IconChequeredFlagOutline24 as GoalIcon,
  IconXmarkOutline24 as XIcon,
} from "nucleo-core-outline-24";

import { cn } from "~/lib/utils";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Menu, MenuItem, MenuPopup, MenuSeparator, MenuTrigger } from "../ui/menu";

interface GoalStatusMenuProps {
  goal: ThreadGoal;
  disabled?: boolean;
  onSetStatus: (status: ThreadGoalStatus) => Promise<void>;
  onClearGoal: () => Promise<void>;
}

const STATUS_LABELS: Record<ThreadGoalStatus, string> = {
  active: "Active",
  paused: "Paused",
  blocked: "Blocked",
  usageLimited: "Usage limited",
  budgetLimited: "Budget limited",
  complete: "Complete",
};

function goalBadgeVariant(status: ThreadGoalStatus): "success" | "warning" | "outline" | "info" {
  switch (status) {
    case "active":
      return "success";
    case "blocked":
    case "budgetLimited":
    case "usageLimited":
      return "warning";
    case "complete":
      return "info";
    case "paused":
      return "outline";
  }
}

export const GoalStatusMenu = memo(function GoalStatusMenu({
  goal,
  disabled = false,
  onSetStatus,
  onClearGoal,
}: GoalStatusMenuProps) {
  const [busyAction, setBusyAction] = useState<string | null>(null);

  const runAction = async (key: string, action: () => Promise<void>) => {
    if (busyAction !== null) {
      return;
    }
    setBusyAction(key);
    try {
      await action();
    } finally {
      setBusyAction(null);
    }
  };

  return (
    <Menu>
      <MenuTrigger
        render={
          <Button
            size="sm"
            variant="ghost"
            className="shrink-0 gap-1 px-1.5 text-muted-foreground/80 hover:text-foreground"
            aria-label={`Goal ${STATUS_LABELS[goal.status]}`}
            disabled={disabled}
            type="button"
          />
        }
      >
        <GoalIcon aria-hidden className="size-4" />
        <span className="hidden max-w-24 truncate text-[11px] sm:inline">
          {STATUS_LABELS[goal.status]}
        </span>
      </MenuTrigger>
      <MenuPopup align="start" side="top" sideOffset={8} className="w-72">
        <div className="space-y-2 px-2 py-2">
          <div className="flex items-center justify-between gap-2">
            <span className="font-medium text-xs text-muted-foreground">Goal</span>
            <Badge size="sm" variant={goalBadgeVariant(goal.status)}>
              {STATUS_LABELS[goal.status]}
            </Badge>
          </div>
          <p className="line-clamp-3 text-sm text-foreground">{goal.objective}</p>
          {goal.tokenBudget !== null ? (
            <p className="text-[11px] text-muted-foreground">
              {goal.tokensUsed}/{goal.tokenBudget} tokens
            </p>
          ) : null}
        </div>
        <MenuSeparator />
        {goal.status === "active" ? (
          <MenuItem onClick={() => void runAction("paused", () => onSetStatus("paused"))}>
            Pause goal
          </MenuItem>
        ) : goal.status !== "complete" ? (
          <MenuItem onClick={() => void runAction("active", () => onSetStatus("active"))}>
            Resume goal
          </MenuItem>
        ) : null}
        {goal.status !== "complete" ? (
          <MenuItem onClick={() => void runAction("complete", () => onSetStatus("complete"))}>
            Mark complete
          </MenuItem>
        ) : (
          <MenuItem onClick={() => void runAction("active", () => onSetStatus("active"))}>
            Reopen goal
          </MenuItem>
        )}
        <MenuSeparator />
        <MenuItem
          onClick={() => void runAction("clear", onClearGoal)}
          className={cn("text-destructive focus:text-destructive")}
        >
          Clear goal
        </MenuItem>
      </MenuPopup>
    </Menu>
  );
});

interface GoalSendModeBadgeProps {
  onDismiss: () => void;
}

export const GoalSendModeBadge = memo(function GoalSendModeBadge({
  onDismiss,
}: GoalSendModeBadgeProps) {
  return (
    <button
      type="button"
      onClick={onDismiss}
      title="Click to stop sending as goal"
      className="group/goal inline-flex w-fit cursor-pointer items-center gap-1 rounded-md bg-primary/8 px-1.5 py-0.5 transition-colors duration-120 hover:bg-primary/14"
    >
      <GoalIcon className="size-3.5 text-primary/70" aria-hidden />
      <span className="text-xs font-medium text-primary">Sending as goal</span>
      <XIcon className="size-3 text-primary/50 transition-colors group-hover/goal:text-primary" />
    </button>
  );
});
