import { useCallback, useEffect, useMemo, useState } from "react";
import {
  IconSpinnerLoaderOutline24 as Loader2,
  IconPlusOutline24 as Plus,
} from "nucleo-core-outline-24";

import {
  DEFAULT_PROVIDER_INTERACTION_MODE,
  DEFAULT_RUNTIME_MODE,
  ProjectId,
  type AutomationCreateInput,
  type ModelSelection,
  type ProviderKind,
  type RuntimeMode,
} from "contracts";

import { Button } from "~/components/ui/button";
import { ProviderModelPicker } from "~/components/chat/ProviderModelPicker";
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
import { useSettings } from "~/hooks/useSettings";
import {
  buildProviderModelSelection,
  getCustomModelOptionsByProvider,
  resolveConfigurableModelSelectionState,
} from "~/modelSelection";
import { useServerProviders } from "~/rpc/serverState";
import { useStore } from "~/store";

import { HEARTBEAT_INTERVALS, intervalLabel } from "./automationShared";

interface NewAutomationDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onCreate: (input: AutomationCreateInput) => Promise<void>;
  isCreating: boolean;
}

const DEFAULT_TITLE = "Scheduled automation";
const DEFAULT_PROMPT = "Run this scheduled task and report what changed.";
const ACCESS_LABELS: Record<RuntimeMode, string> = {
  "full-access": "Full access",
  "approval-required": "Ask for approval",
};

export function NewAutomationDialog({
  open,
  onOpenChange,
  onCreate,
  isCreating,
}: NewAutomationDialogProps) {
  const settings = useSettings();
  const serverProviders = useServerProviders();
  const projects = useStore((store) => store.projects);
  const projectById = useMemo(
    () => new Map(projects.map((project) => [project.id, project] as const)),
    [projects],
  );
  const resolveDefaultModelSelection = useCallback(
    (projectId: string): ModelSelection => {
      const project = projectById.get(ProjectId.makeUnsafe(projectId));
      return resolveConfigurableModelSelectionState(
        project?.defaultModelSelection ?? settings.defaultModelSelection,
        settings,
        serverProviders,
      );
    },
    [projectById, serverProviders, settings],
  );

  const [title, setTitle] = useState(DEFAULT_TITLE);
  const [prompt, setPrompt] = useState(DEFAULT_PROMPT);
  const [projectId, setProjectId] = useState<string>("");
  const [modelSelection, setModelSelection] = useState<ModelSelection>(() =>
    resolveConfigurableModelSelectionState(
      settings.defaultModelSelection,
      settings,
      serverProviders,
    ),
  );
  const [runtimeMode, setRuntimeMode] = useState<RuntimeMode>(DEFAULT_RUNTIME_MODE);
  const [scheduleRrule, setScheduleRrule] = useState<string>(HEARTBEAT_INTERVALS[1]!.rrule);
  const selectedProject = projectId ? projectById.get(ProjectId.makeUnsafe(projectId)) : undefined;
  const modelOptionsByProvider = useMemo(
    () =>
      getCustomModelOptionsByProvider(
        settings,
        serverProviders,
        modelSelection.provider,
        modelSelection.model,
      ),
    [modelSelection.model, modelSelection.provider, serverProviders, settings],
  );

  useEffect(() => {
    if (!open) return;
    const nextProjectId = projects[0]?.id ?? "";
    setTitle(DEFAULT_TITLE);
    setPrompt(DEFAULT_PROMPT);
    setScheduleRrule(HEARTBEAT_INTERVALS[1]!.rrule);
    setProjectId(nextProjectId);
    setModelSelection(
      nextProjectId
        ? resolveDefaultModelSelection(nextProjectId)
        : resolveConfigurableModelSelectionState(
            settings.defaultModelSelection,
            settings,
            serverProviders,
          ),
    );
    setRuntimeMode(DEFAULT_RUNTIME_MODE);
  }, [open, projects, resolveDefaultModelSelection, serverProviders, settings]);

  const submitDisabled =
    isCreating || title.trim().length === 0 || prompt.trim().length === 0 || projectId.length === 0;

  const submit = () => {
    if (submitDisabled) return;
    void onCreate({
      title: title.trim(),
      prompt: prompt.trim(),
      projectId: ProjectId.makeUnsafe(projectId),
      projectlessCwd: null,
      modelSelection,
      runtimeMode,
      interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
      scheduleRrule,
      status: "active",
    });
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogPopup className="max-w-md">
        <DialogHeader>
          <DialogTitle>New automation</DialogTitle>
          <DialogDescription>
            Create a new thread on a schedule and run a prompt automatically.
          </DialogDescription>
        </DialogHeader>
        <DialogPanel className="flex flex-col gap-3">
          <div className="flex flex-col gap-1.5">
            <label
              htmlFor="automation-new-title"
              className="text-[11px] font-medium text-muted-foreground/75"
            >
              Title
            </label>
            <Input
              id="automation-new-title"
              autoFocus
              value={title}
              onChange={(event) => setTitle(event.currentTarget.value)}
            />
          </div>
          <div className="flex flex-col gap-1.5">
            <label
              htmlFor="automation-new-project"
              className="text-[11px] font-medium text-muted-foreground/75"
            >
              Project
            </label>
            <Select
              value={projectId}
              onValueChange={(value) => {
                const nextProjectId = value ?? "";
                setProjectId(nextProjectId);
                if (nextProjectId) {
                  setModelSelection(resolveDefaultModelSelection(nextProjectId));
                }
              }}
            >
              <SelectTrigger id="automation-new-project" size="sm" className="w-full">
                <SelectValue placeholder="Select a project">
                  {selectedProject?.name ?? "Select a project"}
                </SelectValue>
              </SelectTrigger>
              <SelectPopup align="start" alignItemWithTrigger={false}>
                {projects.map((project) => (
                  <SelectItem key={project.id} value={project.id} hideIndicator>
                    <span className="block min-w-0 truncate">{project.name}</span>
                    <span className="block truncate text-xs text-muted-foreground">
                      {project.cwd}
                    </span>
                  </SelectItem>
                ))}
              </SelectPopup>
            </Select>
          </div>
          <div className="flex flex-col gap-1.5">
            <span className="text-[11px] font-medium text-muted-foreground/75">Model</span>
            <ProviderModelPicker
              provider={modelSelection.provider}
              model={modelSelection.model}
              lockedProvider={null}
              providers={serverProviders}
              modelOptionsByProvider={modelOptionsByProvider}
              modelOptions={modelSelection.options}
              triggerVariant="outline"
              triggerClassName="w-full justify-start"
              onProviderModelChange={(provider: ProviderKind, model: string) => {
                setModelSelection(
                  resolveConfigurableModelSelectionState(
                    buildProviderModelSelection(provider, model),
                    settings,
                    serverProviders,
                  ),
                );
              }}
            />
          </div>
          <div className="flex flex-col gap-1.5">
            <label
              htmlFor="automation-new-runtime"
              className="text-[11px] font-medium text-muted-foreground/75"
            >
              Access
            </label>
            <Select
              value={runtimeMode}
              onValueChange={(value) =>
                setRuntimeMode((value ?? DEFAULT_RUNTIME_MODE) as RuntimeMode)
              }
            >
              <SelectTrigger id="automation-new-runtime" size="sm" className="w-full">
                <SelectValue>{ACCESS_LABELS[runtimeMode]}</SelectValue>
              </SelectTrigger>
              <SelectPopup align="start" alignItemWithTrigger={false}>
                <SelectItem value="full-access" hideIndicator>
                  Full access
                </SelectItem>
                <SelectItem value="approval-required" hideIndicator>
                  Ask for approval
                </SelectItem>
              </SelectPopup>
            </Select>
          </div>
          <div className="flex flex-col gap-1.5">
            <label
              htmlFor="automation-new-schedule"
              className="text-[11px] font-medium text-muted-foreground/75"
            >
              Schedule
            </label>
            <Select value={scheduleRrule} onValueChange={(value) => setScheduleRrule(value ?? "")}>
              <SelectTrigger id="automation-new-schedule" size="sm" className="w-full">
                <SelectValue>{intervalLabel(scheduleRrule)}</SelectValue>
              </SelectTrigger>
              <SelectPopup align="start" alignItemWithTrigger={false}>
                {HEARTBEAT_INTERVALS.map((interval) => (
                  <SelectItem key={interval.rrule} value={interval.rrule} hideIndicator>
                    {interval.label}
                  </SelectItem>
                ))}
              </SelectPopup>
            </Select>
          </div>
          <div className="flex flex-col gap-1.5">
            <label
              htmlFor="automation-new-prompt"
              className="text-[11px] font-medium text-muted-foreground/75"
            >
              Prompt
            </label>
            <Textarea
              id="automation-new-prompt"
              className="min-h-24 resize-y"
              value={prompt}
              onChange={(event) => setPrompt(event.currentTarget.value)}
              rows={4}
            />
          </div>
        </DialogPanel>
        <DialogFooter variant="bare">
          <Button type="button" variant="outline" size="sm" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button type="button" size="sm" disabled={submitDisabled} onClick={submit}>
            {isCreating ? (
              <Loader2 className="size-3.5 animate-spin" aria-hidden />
            ) : (
              <Plus className="size-3.5" aria-hidden />
            )}
            Create automation
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}
