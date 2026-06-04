import { type ProjectId } from "contracts";
import { useEffect, useState } from "react";
import {
  IconChevronDownOutline24 as ChevronDownIcon,
  IconChevronRightOutline24 as ChevronRightIcon,
  IconSpinnerLoaderOutline24 as Loader2Icon,
  IconPlusOutline24 as PlusIcon,
} from "nucleo-core-outline-24";

import { Button } from "~/components/ui/button";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "~/components/ui/dialog";
import { Input } from "~/components/ui/input";
import {
  Select,
  SelectItem,
  SelectPopup,
  SelectTrigger,
  SelectValue,
} from "~/components/ui/select";
import { Textarea } from "~/components/ui/textarea";

interface NewGoalDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description: string;
  projectId: ProjectId | null;
  projects: ReadonlyArray<{ id: string; name: string }>;
  projectLocked: boolean;
  onTitleChange: (value: string) => void;
  onDescriptionChange: (value: string) => void;
  onProjectIdChange: (value: ProjectId | null) => void;
  onSubmit: () => void;
  isCreating: boolean;
}

export function NewGoalDialog({
  open,
  onOpenChange,
  title,
  description,
  projectId,
  projects,
  projectLocked,
  onTitleChange,
  onDescriptionChange,
  onProjectIdChange,
  onSubmit,
  isCreating,
}: NewGoalDialogProps) {
  const submitDisabled = projectId === null || title.trim().length === 0 || isCreating;
  const submit = () => {
    if (submitDisabled) return;
    onSubmit();
  };
  // Only ask which project when there's an actual choice to make.
  const showProjectPicker = !projectLocked && projects.length > 1;
  const selectedProjectName = projects.find((project) => project.id === projectId)?.name ?? null;

  const [detailsOpen, setDetailsOpen] = useState(false);
  useEffect(() => {
    if (open) setDetailsOpen(description.trim().length > 0);
  }, [open, description]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogPopup className="max-w-md">
        <DialogHeader>
          <DialogTitle>New Goal</DialogTitle>
          <DialogDescription>
            Describe the outcome. ShioriCode will create or refine the plan before running code.
          </DialogDescription>
        </DialogHeader>
        <DialogPanel className="flex flex-col gap-3">
          {showProjectPicker ? (
            <div className="flex flex-col gap-1.5">
              <label
                htmlFor="goal-new-task-project"
                className="text-[11px] font-medium text-muted-foreground/75"
              >
                Project
              </label>
              <Select
                value={projectId ?? ""}
                onValueChange={(next) => {
                  if (typeof next === "string" && next.length > 0) {
                    onProjectIdChange(next as ProjectId);
                  }
                }}
              >
                <SelectTrigger id="goal-new-task-project" size="sm" className="w-full">
                  <SelectValue>
                    {selectedProjectName ?? (
                      <span className="text-muted-foreground/65">Select a project</span>
                    )}
                  </SelectValue>
                </SelectTrigger>
                <SelectPopup align="start" alignItemWithTrigger={false}>
                  {projects.map((project) => (
                    <SelectItem hideIndicator key={project.id} value={project.id}>
                      {project.name}
                    </SelectItem>
                  ))}
                </SelectPopup>
              </Select>
            </div>
          ) : null}
          <Input
            autoFocus
            placeholder="What should ShioriCode accomplish?"
            value={title}
            onChange={(event) => onTitleChange(event.currentTarget.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter" && !event.shiftKey) {
                event.preventDefault();
                submit();
              }
            }}
          />
          {detailsOpen ? (
            <Textarea
              autoFocus
              placeholder="Description, constraints, context, or files to consider"
              value={description}
              onChange={(event) => onDescriptionChange(event.currentTarget.value)}
              rows={4}
            />
          ) : (
            <button
              type="button"
              onClick={() => setDetailsOpen(true)}
              className="-ml-1 inline-flex w-fit items-center gap-1 rounded px-1 py-0.5 text-[12px] text-muted-foreground transition-colors hover:text-foreground"
            >
              <ChevronRightIcon className="size-3.5" aria-hidden />
              Add details
            </button>
          )}
          {detailsOpen ? (
            <button
              type="button"
              onClick={() => setDetailsOpen(false)}
              className="-ml-1 inline-flex w-fit items-center gap-1 rounded px-1 py-0.5 text-[12px] text-muted-foreground transition-colors hover:text-foreground"
            >
              <ChevronDownIcon className="size-3.5" aria-hidden />
              Hide details
            </button>
          ) : null}
        </DialogPanel>
        <DialogFooter variant="bare">
          <Button type="button" variant="outline" size="sm" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button type="button" size="sm" disabled={submitDisabled} onClick={submit}>
            {isCreating ? (
              <Loader2Icon className="size-3.5 animate-spin" aria-hidden />
            ) : (
              <PlusIcon className="size-3.5" aria-hidden />
            )}
            Create Goal
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}
