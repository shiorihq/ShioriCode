import type { ThreadId } from "contracts";
import { memo, useEffect, useMemo, useState } from "react";
import {
  IconChequeredFlagOutline24 as GoalIcon,
  IconChevronDownOutline24 as ChevronDownIcon,
  IconChevronRightOutline24 as ChevronRightIcon,
} from "nucleo-core-outline-24";

import { cn } from "~/lib/utils";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";
import { Input } from "../ui/input";
import { Menu, MenuItem, MenuPopup, MenuSeparator, MenuTrigger } from "../ui/menu";
import { Textarea } from "../ui/textarea";

interface GoalModeMenuProps {
  threadId: ThreadId;
  goal: ThreadGoal | null;
  disabled?: boolean;
  onSetGoal: (patch: {
    objective?: string;
    status?: ThreadGoalStatus;
    tokenBudget?: number | null;
  }) => Promise<void>;
  onClearGoal: () => Promise<void>;
}

type ThreadGoalStatus =
  | "active"
  | "paused"
  | "blocked"
  | "usageLimited"
  | "budgetLimited"
  | "complete";

interface ThreadGoal {
  objective: string;
  status: ThreadGoalStatus;
  tokenBudget: number | null;
  tokensUsed: number;
}

const STATUS_LABELS: Record<ThreadGoalStatus, string> = {
  active: "Active",
  paused: "Paused",
  blocked: "Blocked",
  usageLimited: "Usage limited",
  budgetLimited: "Budget limited",
  complete: "Complete",
};

function parseTokenBudget(value: string): number | null {
  const trimmed = value.trim();
  if (!trimmed) {
    return null;
  }
  const parsed = Number(trimmed);
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : null;
}

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

export const GoalModeMenu = memo(function GoalModeMenu({
  threadId: _threadId,
  goal,
  disabled = false,
  onSetGoal,
  onClearGoal,
}: GoalModeMenuProps) {
  const [dialogOpen, setDialogOpen] = useState(false);
  const [objective, setObjective] = useState(goal?.objective ?? "");
  const [tokenBudget, setTokenBudget] = useState(
    goal?.tokenBudget !== null && goal?.tokenBudget !== undefined ? String(goal.tokenBudget) : "",
  );
  const [budgetOpen, setBudgetOpen] = useState(false);
  const [busyAction, setBusyAction] = useState<string | null>(null);

  useEffect(() => {
    if (!dialogOpen) {
      return;
    }
    const nextBudget =
      goal?.tokenBudget !== null && goal?.tokenBudget !== undefined ? String(goal.tokenBudget) : "";
    setObjective(goal?.objective ?? "");
    setTokenBudget(nextBudget);
    setBudgetOpen(nextBudget.length > 0);
  }, [dialogOpen, goal]);

  const trimmedObjective = objective.trim();
  const tokenBudgetValue = useMemo(() => parseTokenBudget(tokenBudget), [tokenBudget]);
  const tokenBudgetInvalid = tokenBudget.trim().length > 0 && tokenBudgetValue === null;
  const canSave = trimmedObjective.length > 0 && !tokenBudgetInvalid && busyAction === null;

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

  const saveGoal = () =>
    runAction("save", async () => {
      if (!canSave) {
        return;
      }
      const patch: Parameters<typeof onSetGoal>[0] = {
        objective: trimmedObjective,
        tokenBudget: tokenBudgetValue,
      };
      if (goal?.status === "complete" || goal?.status === "budgetLimited") {
        patch.status = "active";
      }
      await onSetGoal(patch);
      setDialogOpen(false);
    });

  const setStatus = (status: ThreadGoalStatus) =>
    runAction(status, () =>
      onSetGoal({
        status,
      }),
    );

  return (
    <>
      <Menu>
        <MenuTrigger
          render={
            <Button
              size="sm"
              variant="ghost"
              className={cn(
                "shrink-0 gap-1 px-1.5 text-muted-foreground/80 hover:text-foreground",
                goal && "text-foreground",
              )}
              aria-label={goal ? `Goal mode ${STATUS_LABELS[goal.status]}` : "Set goal mode"}
              disabled={disabled}
              type="button"
            />
          }
        >
          <GoalIcon aria-hidden className="size-4" />
          {goal ? (
            <span className="hidden max-w-24 truncate text-[11px] sm:inline">
              {STATUS_LABELS[goal.status]}
            </span>
          ) : null}
        </MenuTrigger>
        <MenuPopup align="start" side="top" sideOffset={8} className="w-72">
          {goal ? (
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
          ) : (
            <div className="px-2 py-2 text-sm text-muted-foreground">No goal set</div>
          )}
          <MenuSeparator />
          <MenuItem onClick={() => setDialogOpen(true)}>{goal ? "Edit goal" : "Set goal"}</MenuItem>
          {goal ? (
            <>
              {goal.status === "active" ? (
                <MenuItem onClick={() => void setStatus("paused")}>Pause goal</MenuItem>
              ) : goal.status !== "complete" ? (
                <MenuItem onClick={() => void setStatus("active")}>Resume goal</MenuItem>
              ) : null}
              {goal.status !== "complete" ? (
                <MenuItem onClick={() => void setStatus("complete")}>Mark complete</MenuItem>
              ) : (
                <MenuItem onClick={() => void setStatus("active")}>Reopen goal</MenuItem>
              )}
              <MenuSeparator />
              <MenuItem
                onClick={() => void runAction("clear", onClearGoal)}
                className="text-destructive focus:text-destructive"
              >
                Clear goal
              </MenuItem>
            </>
          ) : null}
        </MenuPopup>
      </Menu>

      <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
        <DialogPopup>
          <DialogHeader>
            <DialogTitle>{goal ? "Edit Goal" : "Set Goal"}</DialogTitle>
            <DialogDescription>
              Goal mode keeps a long-running objective attached to this thread.
            </DialogDescription>
          </DialogHeader>
          <DialogPanel className="space-y-3">
            <label className="block space-y-1.5">
              <span className="text-sm font-medium">Objective</span>
              <Textarea
                autoFocus
                value={objective}
                onChange={(event) => setObjective(event.target.value)}
                placeholder="Ship the feature, including tests and a clean handoff."
              />
            </label>
            {budgetOpen ? (
              <label className="block space-y-1.5">
                <span className="text-sm font-medium">Token budget</span>
                <Input
                  nativeInput
                  inputMode="numeric"
                  value={tokenBudget}
                  onChange={(event) => setTokenBudget(event.target.value)}
                  placeholder="Optional"
                  aria-invalid={tokenBudgetInvalid}
                />
                {tokenBudgetInvalid ? (
                  <span className="text-[11px] text-destructive">
                    Enter a whole number or leave this blank.
                  </span>
                ) : null}
              </label>
            ) : (
              <button
                type="button"
                onClick={() => setBudgetOpen(true)}
                className="-ml-1 inline-flex w-fit items-center gap-1 rounded px-1 py-0.5 text-[12px] text-muted-foreground transition-colors hover:text-foreground"
              >
                <ChevronRightIcon className="size-3.5" aria-hidden />
                Set token budget
              </button>
            )}
            {budgetOpen ? (
              <button
                type="button"
                onClick={() => {
                  setBudgetOpen(false);
                  setTokenBudget("");
                }}
                className="-ml-1 inline-flex w-fit items-center gap-1 rounded px-1 py-0.5 text-[12px] text-muted-foreground transition-colors hover:text-foreground"
              >
                <ChevronDownIcon className="size-3.5" aria-hidden />
                Remove token budget
              </button>
            ) : null}
          </DialogPanel>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setDialogOpen(false)}>
              Cancel
            </Button>
            <Button onClick={() => void saveGoal()} disabled={!canSave}>
              Save goal
            </Button>
          </DialogFooter>
        </DialogPopup>
      </Dialog>
    </>
  );
});
