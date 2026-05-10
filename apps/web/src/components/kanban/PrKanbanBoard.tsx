import type { KanbanItemId, ModelSelection, ProjectId } from "contracts";
import {
  ArrowDownIcon,
  ArrowUpIcon,
  BotIcon,
  CheckIcon,
  CircleDotDashedIcon,
  FileTextIcon,
  GitPullRequestIcon,
  GripVerticalIcon,
  Loader2Icon,
  PauseIcon,
  PlayIcon,
  PlusIcon,
  RotateCcwIcon,
  SaveIcon,
  SparklesIcon,
  SquareIcon,
  Trash2Icon,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";

import { Button } from "~/components/ui/button";
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "~/components/ui/empty";
import { Input } from "~/components/ui/input";
import { Textarea } from "~/components/ui/textarea";
import { useSettings } from "~/hooks/useSettings";
import { cn, newCommandId } from "~/lib/utils";
import { readNativeApi } from "~/nativeApi";
import {
  derivePendingApprovals,
  derivePendingUserInputs,
  deriveWorkLogEntries,
  type WorkLogEntry,
} from "~/session-logic";
import { useStore } from "~/store";
import { formatRelativeTimeLabel } from "~/timestampFormat";
import type { Project, Thread } from "~/types";

import { NewTaskDialog } from "./NewTaskDialog";
import {
  buildGoalRunPrompt,
  deriveGoalStatus,
  dispatchGoalCommand,
  fallbackPlanForGoal,
  findGoalRunThread,
  GOAL_STATUS_LABELS,
  GOAL_STATUS_ORDER,
  GOAL_STATUS_THEME,
  markdownFromPlanSteps,
  newId,
  newSortKey,
  planStepsFromMarkdown,
  providerLabel,
  runGoal,
  sortGoals,
  type Goal,
  type GoalAgentFilter,
  type GoalStatus,
} from "./goalShared";

export type KanbanAgentFilter = GoalAgentFilter;

interface PrKanbanBoardProps {
  projectId: ProjectId | null;
  pullRequest: Goal["pullRequest"] | null;
  searchQuery?: string;
  agentFilter?: GoalAgentFilter;
  blockedOnly?: boolean;
  composerOpen?: boolean;
  onComposerOpenChange?: (open: boolean) => void;
}

export function PrKanbanBoard({
  projectId,
  pullRequest,
  searchQuery = "",
  agentFilter = "any",
  blockedOnly = false,
  composerOpen,
  onComposerOpenChange,
}: PrKanbanBoardProps) {
  const projects = useStore((state) => state.projects);
  const goals = useStore((state) => state.kanbanItems ?? []);
  const threads = useStore((state) => state.threads);
  const bootstrapComplete = useStore((state) => state.bootstrapComplete);
  const defaultModelSelection = useSettings().defaultModelSelection ?? null;
  const [selectedGoalId, setSelectedGoalId] = useState<KanbanItemId | null>(null);
  const [internalComposerOpen, setInternalComposerOpen] = useState(false);
  const [draftProjectId, setDraftProjectId] = useState<ProjectId | null>(projectId);
  const [draftTitle, setDraftTitle] = useState("");
  const [draftDescription, setDraftDescription] = useState("");
  const [draftPrompt, setDraftPrompt] = useState("");

  const newGoalOpen = composerOpen ?? internalComposerOpen;
  const setNewGoalOpen = onComposerOpenChange ?? setInternalComposerOpen;

  useEffect(() => {
    setDraftProjectId(projectId ?? (projects[0]?.id as ProjectId | undefined) ?? null);
  }, [projectId, projects]);

  const visibleGoals = useMemo(() => {
    const query = searchQuery.trim().toLowerCase();
    return sortGoals(
      goals.filter((goal) => {
        if (goal.deletedAt !== null) return false;
        if (projectId && goal.projectId !== projectId) return false;
        if (pullRequest) {
          if (!goal.pullRequest) return false;
          if (goal.pullRequest.url !== pullRequest.url) return false;
        }
        if (blockedOnly && !goal.blockedReason) return false;
        if (agentFilter === "unassigned" && goal.assignees.length > 0) return false;
        if (
          agentFilter !== "any" &&
          agentFilter !== "unassigned" &&
          !goal.assignees.some((assignee) => assignee.provider === agentFilter)
        ) {
          return false;
        }
        if (!query) return true;
        const searchable =
          `${goal.title}\n${goal.description}\n${goal.prompt}\n${goal.generatedPrompt ?? ""}`.toLowerCase();
        return searchable.includes(query);
      }),
    );
  }, [agentFilter, blockedOnly, goals, projectId, pullRequest, searchQuery]);

  const groupedGoals = useMemo(() => {
    const grouped = new Map<GoalStatus, Goal[]>();
    for (const status of GOAL_STATUS_ORDER) grouped.set(status, []);
    for (const goal of visibleGoals) {
      grouped.get(deriveGoalStatus(goal, threads))?.push(goal);
    }
    return grouped;
  }, [threads, visibleGoals]);

  const selectedGoal =
    visibleGoals.find((goal) => goal.id === selectedGoalId) ?? visibleGoals[0] ?? null;
  const selectedProject = selectedGoal
    ? (projects.find((project) => project.id === selectedGoal.projectId) ?? null)
    : null;

  useEffect(() => {
    if (!selectedGoal) {
      setSelectedGoalId(null);
      return;
    }
    if (selectedGoal.id !== selectedGoalId) {
      setSelectedGoalId(selectedGoal.id);
    }
  }, [selectedGoal, selectedGoalId]);

  const createGoal = useCallback(
    (input: {
      title: string;
      description?: string;
      prompt?: string;
      projectId?: ProjectId | null;
    }) => {
      const targetProjectId = input.projectId ?? projectId ?? draftProjectId;
      if (!targetProjectId) return;
      const plan = input.prompt?.trim() ?? "";
      const now = new Date().toISOString();
      const goalId = newId("kanban_item") as KanbanItemId;
      void dispatchGoalCommand({
        type: "kanbanItem.create",
        commandId: newCommandId(),
        itemId: goalId,
        projectId: targetProjectId,
        pullRequest,
        title: input.title.trim(),
        description: input.description?.trim() ?? "",
        prompt: plan,
        generatedPrompt: plan.length > 0 ? plan : null,
        promptStatus: plan.length > 0 ? "ready" : "idle",
        status: plan.length > 0 ? "todo" : "backlog",
        sortKey: newSortKey(),
        createdAt: now,
      });
      setSelectedGoalId(goalId);
    },
    [draftProjectId, projectId, pullRequest],
  );

  const submitDialog = useCallback(() => {
    if (draftTitle.trim().length === 0) return;
    createGoal({
      title: draftTitle,
      description: draftDescription,
      prompt: draftPrompt,
      projectId: draftProjectId,
    });
    setDraftTitle("");
    setDraftDescription("");
    setDraftPrompt("");
    setNewGoalOpen(false);
  }, [createGoal, draftDescription, draftProjectId, draftPrompt, draftTitle, setNewGoalOpen]);

  if (!bootstrapComplete) {
    return (
      <div className="flex h-full min-h-0 items-center justify-center p-6 text-sm text-muted-foreground">
        Loading goals...
      </div>
    );
  }

  return (
    <div className="flex h-full min-h-0 overflow-hidden bg-background">
      {visibleGoals.length > 0 ? (
        <>
          <GoalList
            groupedGoals={groupedGoals}
            selectedGoalId={selectedGoal?.id ?? null}
            threads={threads}
            onSelect={setSelectedGoalId}
            onNewGoal={() => setNewGoalOpen(true)}
          />
          <div className="min-w-0 flex-1 overflow-y-auto">
            {selectedGoal && selectedProject ? (
              <GoalDetail
                goal={selectedGoal}
                project={selectedProject}
                threads={threads}
                fallbackModelSelection={defaultModelSelection}
              />
            ) : null}
          </div>
        </>
      ) : (
        <div className="flex flex-1 items-center justify-center p-6">
          <Empty>
            <EmptyHeader>
              <EmptyMedia variant="icon">
                <CircleDotDashedIcon />
              </EmptyMedia>
              <EmptyTitle>No goals yet</EmptyTitle>
              <EmptyDescription className="text-pretty">
                Describe an outcome. ShioriCode will turn it into a plan before touching code.
              </EmptyDescription>
            </EmptyHeader>
            <EmptyContent>
              <Button
                type="button"
                size="sm"
                onClick={() => setNewGoalOpen(true)}
                disabled={projects.length === 0}
              >
                <PlusIcon className="size-3.5" aria-hidden />
                New Goal
              </Button>
            </EmptyContent>
          </Empty>
        </div>
      )}

      <NewTaskDialog
        open={newGoalOpen}
        onOpenChange={setNewGoalOpen}
        title={draftTitle}
        description={draftDescription}
        prompt={draftPrompt}
        projectId={draftProjectId}
        projects={projects.map((project) => ({ id: project.id, name: project.name }))}
        projectLocked={projectId !== null || pullRequest !== null}
        onTitleChange={setDraftTitle}
        onDescriptionChange={setDraftDescription}
        onPromptChange={setDraftPrompt}
        onProjectIdChange={setDraftProjectId}
        onSubmit={submitDialog}
        isCreating={false}
      />
    </div>
  );
}

function GoalList(props: {
  groupedGoals: Map<GoalStatus, Goal[]>;
  selectedGoalId: KanbanItemId | null;
  threads: readonly Thread[];
  onSelect: (goalId: KanbanItemId) => void;
  onNewGoal: () => void;
}) {
  return (
    <aside className="flex w-[20rem] shrink-0 flex-col border-r border-border/45 bg-muted/[0.18]">
      <div className="flex h-12 shrink-0 items-center justify-between border-b border-border/35 px-3">
        <div>
          <p className="text-[12px] font-medium text-foreground">Goals</p>
          <p className="text-[11px] text-muted-foreground">Plans and active runs</p>
        </div>
        <Button
          type="button"
          size="icon-xs"
          variant="outline"
          aria-label="New Goal"
          onClick={props.onNewGoal}
        >
          <PlusIcon className="size-3.5" aria-hidden />
        </Button>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto p-2">
        {GOAL_STATUS_ORDER.map((status) => {
          const goals = props.groupedGoals.get(status) ?? [];
          if (goals.length === 0) return null;
          return (
            <section key={status} className="mb-3 last:mb-0">
              <div className="mb-1.5 flex items-center gap-2 px-1">
                <StatusChip status={status} />
                <span className="text-[11px] tabular-nums text-muted-foreground/70">
                  {goals.length}
                </span>
              </div>
              <div className="flex flex-col gap-1">
                {goals.map((goal) => {
                  const runThread = findGoalRunThread(goal, props.threads);
                  const stepCount = planStepsFromMarkdown(
                    goal.prompt || (goal.generatedPrompt ?? ""),
                  ).length;
                  const selected = goal.id === props.selectedGoalId;
                  return (
                    <button
                      type="button"
                      key={goal.id}
                      onClick={() => props.onSelect(goal.id)}
                      className={cn(
                        "group flex min-h-[4.25rem] w-full flex-col rounded-md border px-2.5 py-2 text-left transition-colors",
                        selected
                          ? "border-primary/35 bg-background shadow-xs"
                          : "border-transparent hover:border-border/60 hover:bg-background/70",
                      )}
                    >
                      <span className="line-clamp-2 text-[13px] font-medium leading-snug text-foreground">
                        {goal.title}
                      </span>
                      <span className="mt-1 line-clamp-1 text-[11px] text-muted-foreground">
                        {runThread ? `Run: ${runThread.title}` : `${stepCount || 0} plan steps`}
                      </span>
                      <span className="mt-auto flex items-center gap-1.5 pt-1.5 text-[11px] text-muted-foreground/70">
                        <span>{formatRelativeTimeLabel(goal.updatedAt)}</span>
                        {goal.pullRequest ? (
                          <>
                            <span aria-hidden>·</span>
                            <GitPullRequestIcon className="size-3" aria-hidden />
                            <span>#{goal.pullRequest.number}</span>
                          </>
                        ) : null}
                      </span>
                    </button>
                  );
                })}
              </div>
            </section>
          );
        })}
      </div>
    </aside>
  );
}

function GoalDetail(props: {
  goal: Goal;
  project: Project;
  threads: readonly Thread[];
  fallbackModelSelection: ModelSelection | null;
}) {
  const { goal, project, threads, fallbackModelSelection } = props;
  const runThread = findGoalRunThread(goal, threads);
  const status = deriveGoalStatus(goal, threads);
  const savedPlan =
    goal.prompt.trim() || goal.generatedPrompt?.trim() || fallbackPlanForGoal(goal.title);
  const [title, setTitle] = useState(goal.title);
  const [description, setDescription] = useState(goal.description);
  const [planSteps, setPlanSteps] = useState<string[]>(() => planStepsFromMarkdown(savedPlan));
  const [busyAction, setBusyAction] = useState<"save" | "run" | "regenerate" | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const nextPlan =
      goal.prompt.trim() || goal.generatedPrompt?.trim() || fallbackPlanForGoal(goal.title);
    setTitle(goal.title);
    setDescription(goal.description);
    setPlanSteps(planStepsFromMarkdown(nextPlan));
    setError(null);
  }, [goal.id, goal.description, goal.generatedPrompt, goal.prompt, goal.title]);

  const savedEditablePlan = goal.prompt.trim()
    ? goal.prompt.trim()
    : markdownFromPlanSteps(planStepsFromMarkdown(savedPlan));
  const currentPlan = markdownFromPlanSteps(planSteps);
  const dirty =
    title.trim() !== goal.title ||
    description !== goal.description ||
    currentPlan !== savedEditablePlan;

  const saveGoal = useCallback(async () => {
    if (title.trim().length === 0) return;
    setBusyAction("save");
    setError(null);
    try {
      await dispatchGoalCommand({
        type: "kanbanItem.update",
        commandId: newCommandId(),
        itemId: goal.id,
        title: title.trim(),
        description,
        prompt: currentPlan,
        generatedPrompt: currentPlan,
        promptStatus: currentPlan.trim().length > 0 ? "ready" : "idle",
        updatedAt: new Date().toISOString(),
      });
    } finally {
      setBusyAction(null);
    }
  }, [currentPlan, description, goal.id, title]);

  const regeneratePlan = useCallback(async () => {
    setBusyAction("regenerate");
    setError(null);
    try {
      await dispatchGoalCommand({
        type: "kanbanItem.update",
        commandId: newCommandId(),
        itemId: goal.id,
        title: title.trim(),
        description,
        prompt: "",
        generatedPrompt: null,
        promptStatus: "generating",
        updatedAt: new Date().toISOString(),
      });
    } finally {
      setBusyAction(null);
    }
  }, [description, goal.id, title]);

  const startRun = useCallback(async () => {
    setBusyAction("run");
    setError(null);
    try {
      const plan = markdownFromPlanSteps(planSteps);
      const runnableGoal = {
        ...goal,
        title: title.trim(),
        description,
        prompt: plan,
        generatedPrompt: plan,
      };
      if (dirty) {
        await dispatchGoalCommand({
          type: "kanbanItem.update",
          commandId: newCommandId(),
          itemId: goal.id,
          title: title.trim(),
          description,
          prompt: plan,
          generatedPrompt: plan,
          promptStatus: plan.trim().length > 0 ? "ready" : "idle",
          updatedAt: new Date().toISOString(),
        });
      }
      await runGoal({ goal: runnableGoal, project, threads, fallbackModelSelection });
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Unable to run this goal.");
    } finally {
      setBusyAction(null);
    }
  }, [description, dirty, fallbackModelSelection, goal, planSteps, project, threads, title]);

  const pauseRun = useCallback(() => {
    if (!runThread) return;
    void readNativeApi()?.orchestration.dispatchCommand({
      type: "thread.session.stop",
      commandId: newCommandId(),
      threadId: runThread.id,
      createdAt: new Date().toISOString(),
    });
  }, [runThread]);

  const markCompleted = useCallback(() => {
    void dispatchGoalCommand({
      type: "kanbanItem.move",
      commandId: newCommandId(),
      itemId: goal.id,
      status: "done",
      sortKey: goal.sortKey,
      movedAt: new Date().toISOString(),
    });
  }, [goal.id, goal.sortKey]);

  const currentActivity = useMemo(
    () =>
      runThread
        ? deriveWorkLogEntries(runThread.activities, runThread.latestTurn?.turnId)
            .toReversed()
            .slice(0, 5)
        : [],
    [runThread],
  );
  const pendingApprovals = runThread ? derivePendingApprovals(runThread.activities) : [];
  const pendingInputs = runThread ? derivePendingUserInputs(runThread.activities) : [];
  const changedFiles =
    runThread?.turnDiffSummaries.flatMap((summary) => summary.files.map((file) => file.path)) ?? [];
  const uniqueChangedFiles = [...new Set(changedFiles)].slice(-8);
  const recentNotes = goal.notes.toReversed().slice(0, 3);

  return (
    <main className="mx-auto flex w-full max-w-6xl flex-col gap-4 p-4 lg:p-5">
      <section className="border-b border-border/45 pb-4">
        <div className="flex flex-wrap items-start gap-3">
          <div className="min-w-0 flex-1">
            <div className="mb-2 flex flex-wrap items-center gap-2">
              <StatusChip status={status} />
              <span className="text-[12px] text-muted-foreground">{project.name}</span>
              {goal.pullRequest ? (
                <span className="inline-flex items-center gap-1 rounded-md border border-border/50 px-1.5 py-0.5 text-[11px] text-muted-foreground">
                  <GitPullRequestIcon className="size-3" aria-hidden />
                  PR #{goal.pullRequest.number}
                </span>
              ) : null}
            </div>
            <Input
              value={title}
              onChange={(event) => setTitle(event.currentTarget.value)}
              aria-label="Goal title"
              className="h-auto border-0 bg-transparent px-0 text-[20px] font-semibold tracking-tight shadow-none focus-visible:ring-0"
            />
            <Textarea
              value={description}
              onChange={(event) => setDescription(event.currentTarget.value)}
              placeholder="Add constraints, context, files to inspect, or things ShioriCode should avoid."
              rows={3}
              aria-label="Goal description and constraints"
              className="mt-2 resize-none border-border/45 bg-muted/20 text-[13px]"
            />
          </div>
          <div className="flex shrink-0 flex-wrap items-center justify-end gap-1.5">
            <Button
              type="button"
              size="sm"
              variant="outline"
              disabled={!dirty || busyAction !== null}
              onClick={() => void saveGoal()}
            >
              {busyAction === "save" ? (
                <Loader2Icon className="size-3.5 animate-spin" aria-hidden />
              ) : (
                <SaveIcon className="size-3.5" aria-hidden />
              )}
              Save
            </Button>
            <Button
              type="button"
              size="sm"
              variant="outline"
              disabled={busyAction !== null}
              onClick={() => void regeneratePlan()}
            >
              {busyAction === "regenerate" ? (
                <Loader2Icon className="size-3.5 animate-spin" aria-hidden />
              ) : (
                <SparklesIcon className="size-3.5" aria-hidden />
              )}
              Regenerate Plan
            </Button>
            {status === "running" || status === "needs_approval" ? (
              <Button type="button" size="sm" variant="outline" onClick={pauseRun}>
                <PauseIcon className="size-3.5" aria-hidden />
                Pause
              </Button>
            ) : (
              <Button
                type="button"
                size="sm"
                disabled={busyAction !== null || planSteps.length === 0}
                onClick={() => void startRun()}
              >
                {busyAction === "run" ? (
                  <Loader2Icon className="size-3.5 animate-spin" aria-hidden />
                ) : (
                  <PlayIcon className="size-3.5" aria-hidden />
                )}
                Run Goal
              </Button>
            )}
          </div>
        </div>
        {error ? <p className="mt-2 text-[12px] text-destructive">{error}</p> : null}
      </section>

      <div className="grid min-h-0 gap-4 xl:grid-cols-[minmax(0,1fr)_22rem]">
        <div className="flex min-w-0 flex-col gap-4">
          <Panel
            title="Plan"
            action={
              <Button
                type="button"
                size="xs"
                variant="outline"
                onClick={() => setPlanSteps((steps) => [...steps, ""])}
              >
                <PlusIcon className="size-3" aria-hidden />
                Add step
              </Button>
            }
          >
            <PlanEditor steps={planSteps} onChange={setPlanSteps} runThread={runThread} />
          </Panel>

          <Panel title="Current Activity">
            {pendingApprovals.length > 0 || pendingInputs.length > 0 ? (
              <div className="mb-3 rounded-md border border-amber-500/35 bg-amber-500/[0.07] px-3 py-2 text-[12.5px] text-amber-800 dark:text-amber-200">
                ShioriCode is waiting for your input before continuing this run.
              </div>
            ) : null}
            {currentActivity.length > 0 ? (
              <ul className="flex flex-col gap-2">
                {currentActivity.map((entry) => (
                  <ActivityRow key={entry.id} entry={entry} />
                ))}
              </ul>
            ) : (
              <p className="text-[12.5px] text-muted-foreground">
                {runThread
                  ? "No visible activity yet for this run."
                  : "Start the goal to see what ShioriCode is doing now."}
              </p>
            )}
          </Panel>

          <Panel title="Run Summary">
            {status === "completed" ? (
              <div className="space-y-3">
                <p className="text-[13px] text-foreground/85">
                  Goal completed. Review the changes before merging.
                </p>
                <Button type="button" size="sm" variant="outline" onClick={() => void startRun()}>
                  <RotateCcwIcon className="size-3.5" aria-hidden />
                  Run Again
                </Button>
              </div>
            ) : (
              <div className="flex items-center justify-between gap-3">
                <p className="text-[12.5px] text-muted-foreground">
                  A final summary appears here when the run is complete.
                </p>
                {runThread ? (
                  <Button type="button" size="xs" variant="outline" onClick={markCompleted}>
                    <CheckIcon className="size-3" aria-hidden />
                    Mark Done
                  </Button>
                ) : null}
              </div>
            )}
          </Panel>
        </div>

        <div className="flex min-w-0 flex-col gap-4">
          <Panel title="Context">
            <Metric label="Plan steps" value={String(planSteps.length)} />
            <Metric label="Files changed" value={String(uniqueChangedFiles.length)} />
            <Metric label="Approvals" value={String(pendingApprovals.length)} />
            <Metric label="User inputs" value={String(pendingInputs.length)} />
            {runThread ? (
              <div className="mt-3 rounded-md border border-border/45 px-3 py-2">
                <div className="flex items-center gap-2 text-[12px] font-medium text-foreground">
                  <BotIcon className="size-3.5 text-muted-foreground" aria-hidden />
                  {providerLabel(runThread.modelSelection.provider)}
                </div>
                <p className="mt-1 truncate text-[11px] text-muted-foreground">{runThread.title}</p>
              </div>
            ) : null}
          </Panel>

          <Panel title="Files Changed">
            {uniqueChangedFiles.length > 0 ? (
              <ul className="flex flex-col gap-1.5">
                {uniqueChangedFiles.map((file) => (
                  <li
                    key={file}
                    className="flex min-w-0 items-center gap-2 text-[12px] text-foreground/80"
                  >
                    <FileTextIcon className="size-3.5 shrink-0 text-muted-foreground" aria-hidden />
                    <span className="truncate">{file}</span>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="text-[12.5px] text-muted-foreground">No changed files recorded yet.</p>
            )}
          </Panel>

          <Panel title="Recent Notes">
            {recentNotes.length > 0 ? (
              <ul className="flex flex-col gap-2">
                {recentNotes.map((note) => (
                  <li key={note.id} className="rounded-md border border-border/45 px-3 py-2">
                    <p className="text-[12.5px] text-foreground/85">{note.body}</p>
                    <p className="mt-1 text-[11px] text-muted-foreground">
                      {formatRelativeTimeLabel(note.createdAt)}
                    </p>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="text-[12.5px] text-muted-foreground">No run notes yet.</p>
            )}
          </Panel>
        </div>
      </div>

      <section className="sr-only" aria-label="Prepared execution prompt">
        {buildGoalRunPrompt({ ...goal, title, description, prompt: currentPlan })}
      </section>
    </main>
  );
}

function PlanEditor(props: {
  steps: readonly string[];
  onChange: (steps: string[]) => void;
  runThread: Thread | null;
}) {
  const activeIndex = props.runThread?.latestTurn?.state === "running" ? 0 : -1;
  const updateStep = (index: number, value: string) => {
    props.onChange(props.steps.map((step, stepIndex) => (stepIndex === index ? value : step)));
  };
  const moveStep = (index: number, direction: -1 | 1) => {
    const next = [...props.steps];
    const target = index + direction;
    if (target < 0 || target >= next.length) return;
    const [step] = next.splice(index, 1);
    if (!step) return;
    next.splice(target, 0, step);
    props.onChange(next);
  };
  const removeStep = (index: number) => {
    props.onChange(props.steps.filter((_, stepIndex) => stepIndex !== index));
  };

  if (props.steps.length === 0) {
    return (
      <p className="text-[12.5px] text-muted-foreground">
        No plan yet. Add a step or regenerate the plan.
      </p>
    );
  }

  return (
    <ol className="flex flex-col gap-2">
      {props.steps.map((step, index) => {
        const isActive = index === activeIndex;
        const stepKey = `${index}-${step.slice(0, 80)}-${step.length}`;
        return (
          <li
            key={stepKey}
            className={cn(
              "grid grid-cols-[1.5rem_minmax(0,1fr)_auto] items-start gap-2 rounded-md border px-2 py-2",
              isActive
                ? "border-amber-500/35 bg-amber-500/[0.06]"
                : "border-border/45 bg-background",
            )}
          >
            <span className="mt-1 flex size-5 items-center justify-center text-muted-foreground">
              {isActive ? (
                <Loader2Icon className="size-3.5 animate-spin" aria-hidden />
              ) : (
                <GripVerticalIcon className="size-3.5" aria-hidden />
              )}
            </span>
            <Input
              value={step}
              onChange={(event) => updateStep(index, event.currentTarget.value)}
              placeholder="Describe this step"
              aria-label={`Plan step ${index + 1}`}
              className="h-8 border-transparent bg-transparent px-1 text-[13px] shadow-none focus-visible:border-border focus-visible:ring-0"
            />
            <div className="flex items-center gap-0.5">
              <IconButton
                label="Move step up"
                disabled={index === 0}
                onClick={() => moveStep(index, -1)}
              >
                <ArrowUpIcon className="size-3" aria-hidden />
              </IconButton>
              <IconButton
                label="Move step down"
                disabled={index === props.steps.length - 1}
                onClick={() => moveStep(index, 1)}
              >
                <ArrowDownIcon className="size-3" aria-hidden />
              </IconButton>
              <IconButton label="Delete step" onClick={() => removeStep(index)}>
                <Trash2Icon className="size-3" aria-hidden />
              </IconButton>
            </div>
          </li>
        );
      })}
    </ol>
  );
}

function ActivityRow({ entry }: { entry: WorkLogEntry }) {
  return (
    <li className="flex min-w-0 items-start gap-2 rounded-md border border-border/40 px-3 py-2">
      <span className="mt-1 flex size-4 shrink-0 items-center justify-center text-muted-foreground">
        {entry.running ? (
          <Loader2Icon className="size-3.5 animate-spin" aria-hidden />
        ) : entry.tone === "error" ? (
          <SquareIcon className="size-3.5 text-destructive" aria-hidden />
        ) : (
          <CheckIcon className="size-3.5" aria-hidden />
        )}
      </span>
      <div className="min-w-0 flex-1">
        <p className="truncate text-[12.5px] text-foreground/85">{entry.label}</p>
        {entry.detail ? (
          <p className="mt-0.5 line-clamp-2 text-[11px] text-muted-foreground">{entry.detail}</p>
        ) : null}
      </div>
    </li>
  );
}

function Panel(props: { title: string; action?: ReactNode; children: ReactNode }) {
  return (
    <section className="rounded-md border border-border/45 bg-background">
      <header className="flex min-h-10 items-center justify-between gap-3 border-b border-border/35 px-3">
        <h2 className="text-[12px] font-semibold text-foreground">{props.title}</h2>
        {props.action}
      </header>
      <div className="p-3">{props.children}</div>
    </section>
  );
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between border-b border-border/30 py-2 last:border-b-0">
      <span className="text-[12px] text-muted-foreground">{label}</span>
      <span className="text-[12px] font-medium tabular-nums text-foreground">{value}</span>
    </div>
  );
}

function StatusChip({ status }: { status: GoalStatus }) {
  const theme = GOAL_STATUS_THEME[status];
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1.5 rounded-md border px-1.5 py-0.5 text-[11px] font-medium",
        theme.border,
        theme.surface,
        theme.text,
      )}
    >
      <span className={cn("size-1.5 rounded-full", theme.dot)} aria-hidden />
      {GOAL_STATUS_LABELS[status]}
    </span>
  );
}

function IconButton(props: {
  label: string;
  disabled?: boolean;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      aria-label={props.label}
      disabled={props.disabled}
      onClick={props.onClick}
      className="inline-flex size-6 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground disabled:pointer-events-none disabled:opacity-30"
    >
      {props.children}
    </button>
  );
}
