import type { ThreadGoal, ThreadGoalStatus, ThreadGoalUserStatus } from "contracts";
import { memo, useCallback, useEffect, useId, useRef, useState } from "react";
import {
  IconChequeredFlagOutline24 as GoalIcon,
  IconPencilOutline24 as PencilIcon,
  IconSpinnerLoaderOutline24 as Loader2,
  IconXmarkOutline24 as XIcon,
} from "nucleo-core-outline-24";

import { cn } from "~/lib/utils";
import {
  AlertDialog,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogPopup,
  AlertDialogTitle,
} from "../ui/alert-dialog";
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
import {
  type GoalEditorMode,
  type GoalUpdatePatch,
  formatGoalElapsedSeconds,
  formatGoalTokenCount,
  goalTokenProgressPercent,
  mutationErrorMessage,
  resolveGoalEditSubmission,
} from "./goalUi";

interface GoalStatusMenuProps {
  goal: ThreadGoal;
  disabled?: boolean;
  onUpdateGoal: (patch: GoalUpdatePatch) => Promise<void>;
  onClearGoal: () => Promise<void>;
}

function editorWouldReopenConcurrentCompletion(
  openedStatus: ThreadGoal["status"] | null,
  currentStatus: ThreadGoal["status"],
): boolean {
  return openedStatus !== null && openedStatus !== "complete" && currentStatus === "complete";
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

export const GoalProgressSummary = memo(function GoalProgressSummary({
  goal,
}: {
  goal: ThreadGoal;
}) {
  const elapsed = formatGoalElapsedSeconds(goal.timeUsedSeconds);
  const progress = goalTokenProgressPercent(goal);
  const used = formatGoalTokenCount(goal.tokensUsed);
  const budget = goal.tokenBudget === null ? null : formatGoalTokenCount(goal.tokenBudget);

  return (
    <div className="space-y-1.5 text-[11px] text-muted-foreground">
      <div className="flex items-center justify-between gap-3">
        <span>Time {elapsed}</span>
        <span>{budget === null ? `${used} tokens used` : `${used}/${budget} tokens`}</span>
      </div>
      {goal.tokenBudget !== null && progress !== null ? (
        <div
          aria-label={`Goal token budget: ${goal.tokensUsed} of ${goal.tokenBudget} tokens used`}
          aria-valuemax={goal.tokenBudget}
          aria-valuemin={0}
          aria-valuenow={Math.min(goal.tokensUsed, goal.tokenBudget)}
          className="h-1.5 overflow-hidden rounded-full bg-muted"
          role="progressbar"
        >
          <div
            className={cn(
              "h-full rounded-full transition-[width]",
              progress >= 100 ? "bg-warning" : "bg-primary/70",
            )}
            style={{ width: `${progress}%` }}
          />
        </div>
      ) : null}
    </div>
  );
});

export const GoalStatusMenu = memo(function GoalStatusMenu({
  goal,
  disabled = false,
  onUpdateGoal,
  onClearGoal,
}: GoalStatusMenuProps) {
  const objectiveId = useId();
  const budgetId = useId();
  const editorFormId = useId();
  const [busyAction, setBusyAction] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [editorMode, setEditorMode] = useState<GoalEditorMode | null>(null);
  const [objectiveDraft, setObjectiveDraft] = useState(goal.objective);
  const [tokenBudgetDraft, setTokenBudgetDraft] = useState(
    goal.tokenBudget === null ? "" : String(goal.tokenBudget),
  );
  const [clearOpen, setClearOpen] = useState(false);
  const goalLifecycleKey = goal.lifecycleId ?? goal.createdAt;
  const previousGoalLifecycleKeyRef = useRef(goalLifecycleKey);
  const editorOpenedGoalStatusRef = useRef<ThreadGoal["status"] | null>(null);
  const actionRunIdRef = useRef(0);
  const progress = goalTokenProgressPercent(goal);
  const elapsed = formatGoalElapsedSeconds(goal.timeUsedSeconds);
  const tokenSummary =
    goal.tokenBudget === null
      ? `${formatGoalTokenCount(goal.tokensUsed)} tokens used`
      : `${formatGoalTokenCount(goal.tokensUsed)}/${formatGoalTokenCount(goal.tokenBudget)} tokens`;
  const pending = busyAction !== null;
  const closeEditorAfterConcurrentCompletion = useCallback(() => {
    actionRunIdRef.current += 1;
    setBusyAction(null);
    setObjectiveDraft(goal.objective);
    setTokenBudgetDraft(goal.tokenBudget === null ? "" : String(goal.tokenBudget));
    editorOpenedGoalStatusRef.current = null;
    setEditorMode(null);
    setActionError(null);
  }, [goal.objective, goal.tokenBudget]);

  useEffect(() => {
    if (previousGoalLifecycleKeyRef.current === goalLifecycleKey) {
      return;
    }

    previousGoalLifecycleKeyRef.current = goalLifecycleKey;
    actionRunIdRef.current += 1;
    setBusyAction(null);
    setObjectiveDraft(goal.objective);
    setTokenBudgetDraft(goal.tokenBudget === null ? "" : String(goal.tokenBudget));
    editorOpenedGoalStatusRef.current = null;
    setEditorMode(null);
    setClearOpen(false);
    setActionError(null);
  }, [goal.objective, goal.tokenBudget, goalLifecycleKey]);

  useEffect(() => {
    if (
      editorMode === null ||
      !editorWouldReopenConcurrentCompletion(editorOpenedGoalStatusRef.current, goal.status)
    ) {
      return;
    }

    // A completed goal may be deliberately reopened from an editor that was
    // opened while it was already complete. If completion arrives while an
    // older editor is open, however, submitting that stale draft must not
    // silently reactivate the lifecycle.
    closeEditorAfterConcurrentCompletion();
  }, [closeEditorAfterConcurrentCompletion, editorMode, goal.status]);

  const runAction = async (key: string, action: () => Promise<void>, fallback: string) => {
    if (busyAction !== null) {
      return false;
    }
    const actionRunId = actionRunIdRef.current + 1;
    actionRunIdRef.current = actionRunId;
    setActionError(null);
    setBusyAction(key);
    try {
      await action();
      return true;
    } catch (error) {
      if (actionRunIdRef.current === actionRunId) {
        setActionError(mutationErrorMessage(error, fallback));
      }
      return false;
    } finally {
      if (actionRunIdRef.current === actionRunId) {
        setBusyAction(null);
      }
    }
  };

  const updateStatus = (status: ThreadGoalUserStatus) =>
    runAction(status, () => onUpdateGoal({ status }), "Could not update the goal.");

  const openEditor = (mode: GoalEditorMode) => {
    setActionError(null);
    setObjectiveDraft(goal.objective);
    setTokenBudgetDraft(goal.tokenBudget === null ? "" : String(goal.tokenBudget));
    editorOpenedGoalStatusRef.current = goal.status;
    setEditorMode(mode);
  };

  const submitEditor = async () => {
    if (editorMode === null) {
      return;
    }
    if (editorWouldReopenConcurrentCompletion(editorOpenedGoalStatusRef.current, goal.status)) {
      closeEditorAfterConcurrentCompletion();
      return;
    }
    const submission = resolveGoalEditSubmission({
      goal,
      mode: editorMode,
      objective: objectiveDraft,
      tokenBudgetInput: tokenBudgetDraft,
    });
    if (!submission.ok) {
      setActionError(submission.error);
      return;
    }
    if (Object.keys(submission.patch).length === 0) {
      setEditorMode(null);
      return;
    }
    const succeeded = await runAction(
      editorMode,
      () => onUpdateGoal(submission.patch),
      editorMode === "resumeBudget"
        ? "Could not update the budget and resume the goal."
        : "Could not save goal changes.",
    );
    if (succeeded) {
      setEditorMode(null);
    }
  };

  const confirmClear = async () => {
    const succeeded = await runAction("clear", onClearGoal, "Could not clear the goal.");
    if (succeeded) {
      setClearOpen(false);
    }
  };

  return (
    <div className="flex min-w-0 items-center gap-1" aria-busy={pending || undefined}>
      <Menu>
        <MenuTrigger
          render={
            <Button
              size="sm"
              variant="ghost"
              className="shrink-0 gap-1 px-1.5 text-muted-foreground/80 hover:text-foreground"
              aria-label={`Goal ${STATUS_LABELS[goal.status]}. Time ${elapsed}. ${tokenSummary}.`}
              disabled={disabled || pending}
              type="button"
            />
          }
        >
          {pending ? (
            <Loader2 aria-hidden className="size-4 animate-spin" />
          ) : (
            <GoalIcon aria-hidden className="size-4" />
          )}
          <span className="hidden max-w-24 truncate text-[11px] sm:inline">
            {STATUS_LABELS[goal.status]}
          </span>
          <span aria-hidden className="hidden text-[10px] text-muted-foreground/64 md:inline">
            {elapsed}
          </span>
          {goal.tokenBudget !== null ? (
            <span aria-hidden className="hidden text-[10px] text-muted-foreground/64 lg:inline">
              {formatGoalTokenCount(goal.tokensUsed)}/{formatGoalTokenCount(goal.tokenBudget)}
            </span>
          ) : null}
          {progress !== null ? (
            <span
              aria-hidden
              className="hidden h-1 w-9 overflow-hidden rounded-full bg-muted xl:block"
            >
              <span
                className={cn("block h-full", progress >= 100 ? "bg-warning" : "bg-primary/70")}
                style={{ width: `${progress}%` }}
              />
            </span>
          ) : null}
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
            <GoalProgressSummary goal={goal} />
          </div>
          <MenuSeparator />
          <MenuItem
            disabled={pending}
            onClick={() => openEditor(goal.status === "budgetLimited" ? "resumeBudget" : "edit")}
          >
            <PencilIcon aria-hidden />
            Edit goal
          </MenuItem>
          {goal.status === "active" ? (
            <MenuItem disabled={pending} onClick={() => void updateStatus("paused")}>
              Pause goal
            </MenuItem>
          ) : goal.status !== "complete" && goal.status !== "budgetLimited" ? (
            <MenuItem disabled={pending} onClick={() => void updateStatus("active")}>
              Resume goal
            </MenuItem>
          ) : null}
          {goal.status !== "complete" ? (
            <MenuItem disabled={pending} onClick={() => void updateStatus("complete")}>
              Mark complete
            </MenuItem>
          ) : null}
          <MenuSeparator />
          <MenuItem
            disabled={pending}
            onClick={() => {
              setActionError(null);
              setClearOpen(true);
            }}
            className={cn("text-destructive focus:text-destructive")}
          >
            Clear goal…
          </MenuItem>
        </MenuPopup>
      </Menu>

      {actionError !== null && editorMode === null && !clearOpen ? (
        <span
          role="alert"
          title={actionError}
          className="max-w-40 truncate text-[11px] text-destructive"
        >
          {actionError}
        </span>
      ) : null}

      <Dialog
        open={editorMode !== null}
        onOpenChange={(open) => {
          if (!open && !pending) {
            setEditorMode(null);
          }
        }}
      >
        <DialogPopup aria-busy={pending || undefined} className="max-w-md">
          <DialogHeader>
            <DialogTitle>
              {editorMode === "resumeBudget" ? "Adjust budget and resume" : "Edit goal"}
            </DialogTitle>
            <DialogDescription>
              {editorMode === "resumeBudget"
                ? "Increase the exhausted budget, or leave it blank to continue without a limit."
                : "Update the objective or optional token budget without resetting progress."}
            </DialogDescription>
          </DialogHeader>
          <DialogPanel className="space-y-4">
            <form
              id={editorFormId}
              className="space-y-4"
              onSubmit={(event) => {
                event.preventDefault();
                void submitEditor();
              }}
            >
              <div className="space-y-1.5">
                <label
                  htmlFor={objectiveId}
                  className="text-[11px] font-medium text-muted-foreground/75"
                >
                  Objective
                </label>
                <Textarea
                  id={objectiveId}
                  autoFocus
                  disabled={pending}
                  value={objectiveDraft}
                  aria-invalid={objectiveDraft.trim().length === 0 || undefined}
                  onChange={(event) => setObjectiveDraft(event.currentTarget.value)}
                  rows={4}
                />
              </div>
              <div className="space-y-1.5">
                <label
                  htmlFor={budgetId}
                  className="text-[11px] font-medium text-muted-foreground/75"
                >
                  Token budget <span className="font-normal">(optional)</span>
                </label>
                <Input
                  id={budgetId}
                  disabled={pending}
                  inputMode="numeric"
                  min={1}
                  step={1}
                  type="number"
                  value={tokenBudgetDraft}
                  onChange={(event) => setTokenBudgetDraft(event.currentTarget.value)}
                />
                <p className="text-[11px] text-muted-foreground">
                  {editorMode === "resumeBudget"
                    ? `${formatGoalTokenCount(goal.tokensUsed)} tokens used so far. The new limit must be higher.`
                    : "Leave blank for no token limit."}
                </p>
              </div>
              {actionError !== null ? (
                <p role="alert" className="text-sm text-destructive">
                  {actionError}
                </p>
              ) : null}
            </form>
          </DialogPanel>
          <DialogFooter variant="bare">
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={pending}
              onClick={() => setEditorMode(null)}
            >
              Cancel
            </Button>
            <Button type="submit" form={editorFormId} size="sm" disabled={pending}>
              {pending ? <Loader2 aria-hidden className="size-3.5 animate-spin" /> : null}
              {editorMode === "resumeBudget" ? "Save and resume" : "Save changes"}
            </Button>
          </DialogFooter>
        </DialogPopup>
      </Dialog>

      <AlertDialog
        open={clearOpen}
        onOpenChange={(open) => {
          if (!pending) {
            setClearOpen(open);
          }
        }}
      >
        <AlertDialogPopup aria-busy={pending || undefined} className="max-w-md">
          <AlertDialogHeader>
            <AlertDialogTitle>Clear goal?</AlertDialogTitle>
            <AlertDialogDescription>
              This removes the current goal and its recorded progress from this thread.
            </AlertDialogDescription>
            {actionError !== null ? (
              <p role="alert" className="text-sm text-destructive">
                {actionError}
              </p>
            ) : null}
          </AlertDialogHeader>
          <AlertDialogFooter>
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={pending}
              onClick={() => setClearOpen(false)}
            >
              Keep goal
            </Button>
            <Button
              type="button"
              variant="destructive"
              size="sm"
              disabled={pending}
              onClick={() => void confirmClear()}
            >
              {pending ? <Loader2 aria-hidden className="size-3.5 animate-spin" /> : null}
              Clear goal
            </Button>
          </AlertDialogFooter>
        </AlertDialogPopup>
      </AlertDialog>
    </div>
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
