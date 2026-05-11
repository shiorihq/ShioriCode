import { memo, useState, useCallback } from "react";
import { type TimestampFormat } from "contracts/settings";
import { Button } from "./ui/button";
import { ScrollArea } from "./ui/scroll-area";
import ChatMarkdown from "./ChatMarkdown";
import {
  IconCheckOutline24 as CheckIcon,
  IconChevronDownOutline24 as ChevronDownIcon,
  IconChevronRightOutline24 as ChevronRightIcon,
  IconDotsOutline24 as EllipsisIcon,
  IconXmarkOutline24 as XIcon,
} from "nucleo-core-outline-24";
import { cn } from "~/lib/utils";
import type { ActivePlanState } from "../session-logic";
import type { LatestProposedPlanState } from "../session-logic";
import { formatTimestamp } from "../timestampFormat";
import {
  proposedPlanTitle,
  buildProposedPlanMarkdownFilename,
  normalizePlanMarkdownForExport,
  downloadPlanAsTextFile,
  stripDisplayedPlanMarkdown,
} from "../proposedPlan";
import { Menu, MenuItem, MenuPopup, MenuTrigger } from "./ui/menu";
import { readNativeApi } from "~/nativeApi";
import { toastManager } from "./ui/toast";
import { useCopyToClipboard } from "~/hooks/useCopyToClipboard";
import { LoadingText } from "./ui/loading-text";

function StepDot({ status }: { status: string }) {
  if (status === "completed") {
    return (
      <span className="flex size-4 shrink-0 items-center justify-center text-emerald-500">
        <CheckIcon className="size-3" />
      </span>
    );
  }
  if (status === "inProgress") {
    return (
      <span className="flex size-4 shrink-0 items-center justify-center">
        <span className="size-1.5 rounded-full bg-primary" />
      </span>
    );
  }
  return (
    <span className="flex size-4 shrink-0 items-center justify-center">
      <span className="size-1 rounded-full bg-muted-foreground/25" />
    </span>
  );
}

interface PlanSidebarProps {
  activePlan: ActivePlanState | null;
  activeProposedPlan: LatestProposedPlanState | null;
  markdownCwd: string | undefined;
  workspaceRoot: string | undefined;
  timestampFormat: TimestampFormat;
  onClose: () => void;
}

const PlanSidebar = memo(function PlanSidebar({
  activePlan,
  activeProposedPlan,
  markdownCwd,
  workspaceRoot,
  timestampFormat,
  onClose,
}: PlanSidebarProps) {
  const [proposedPlanExpanded, setProposedPlanExpanded] = useState(false);
  const [isSavingToWorkspace, setIsSavingToWorkspace] = useState(false);
  const { copyToClipboard, isCopied } = useCopyToClipboard();

  const planMarkdown = activeProposedPlan?.planMarkdown ?? null;
  const displayedPlanMarkdown = planMarkdown ? stripDisplayedPlanMarkdown(planMarkdown) : null;
  const planTitle = planMarkdown ? proposedPlanTitle(planMarkdown) : null;

  const handleCopyPlan = useCallback(() => {
    if (!planMarkdown) return;
    copyToClipboard(planMarkdown);
  }, [planMarkdown, copyToClipboard]);

  const handleDownload = useCallback(() => {
    if (!planMarkdown) return;
    const filename = buildProposedPlanMarkdownFilename(planMarkdown);
    downloadPlanAsTextFile(filename, normalizePlanMarkdownForExport(planMarkdown));
  }, [planMarkdown]);

  const handleSaveToWorkspace = useCallback(() => {
    const api = readNativeApi();
    if (!api || !workspaceRoot || !planMarkdown) return;
    const filename = buildProposedPlanMarkdownFilename(planMarkdown);
    setIsSavingToWorkspace(true);
    void api.projects
      .writeFile({
        cwd: workspaceRoot,
        relativePath: filename,
        contents: normalizePlanMarkdownForExport(planMarkdown),
      })
      .then((result) => {
        toastManager.add({
          type: "success",
          title: "Plan saved",
          description: result.relativePath,
        });
      })
      .catch((error) => {
        toastManager.add({
          type: "error",
          title: "Could not save plan",
          description: error instanceof Error ? error.message : "An error occurred.",
        });
      })
      .then(
        () => setIsSavingToWorkspace(false),
        () => setIsSavingToWorkspace(false),
      );
  }, [planMarkdown, workspaceRoot]);

  return (
    <div className="flex h-full w-[320px] shrink-0 flex-col border-l border-border/50">
      {/* Header */}
      <div className="flex h-10 shrink-0 items-center justify-between px-3">
        <div className="flex items-center gap-2">
          <span className="text-xs font-medium text-foreground/70">Plan</span>
          {activePlan ? (
            <span className="text-[11px] text-muted-foreground/40">
              {formatTimestamp(activePlan.createdAt, timestampFormat)}
            </span>
          ) : null}
        </div>
        <div className="flex items-center gap-0.5">
          {planMarkdown ? (
            <Menu>
              <MenuTrigger
                render={
                  <Button
                    size="icon-xs"
                    variant="ghost"
                    className="text-muted-foreground/30 hover:text-muted-foreground/60"
                    aria-label="Plan actions"
                  />
                }
              >
                <EllipsisIcon className="size-3.5" />
              </MenuTrigger>
              <MenuPopup align="end">
                <MenuItem onClick={handleCopyPlan}>
                  {isCopied ? "Copied!" : "Copy to clipboard"}
                </MenuItem>
                <MenuItem onClick={handleDownload}>Download as markdown</MenuItem>
                <MenuItem
                  onClick={handleSaveToWorkspace}
                  disabled={!workspaceRoot || isSavingToWorkspace}
                >
                  Save to workspace
                </MenuItem>
              </MenuPopup>
            </Menu>
          ) : null}
          <Button
            size="icon-xs"
            variant="ghost"
            onClick={onClose}
            aria-label="Close plan sidebar"
            className="text-muted-foreground/30 hover:text-muted-foreground/60"
          >
            <XIcon className="size-3.5" />
          </Button>
        </div>
      </div>

      {/* Content */}
      <ScrollArea className="min-h-0 flex-1">
        <div className="space-y-3 px-3 pb-3">
          {/* Explanation */}
          {activePlan?.explanation ? (
            <p className="text-[13px] leading-relaxed text-muted-foreground/60">
              {activePlan.explanation}
            </p>
          ) : null}

          {/* Plan Steps */}
          {activePlan && activePlan.steps.length > 0 ? (
            <div className="space-y-px">
              {activePlan.steps.map((step) => (
                <div key={`${step.status}:${step.step}`} className="flex items-start gap-2 py-1.5">
                  <div className="mt-px">
                    <StepDot status={step.status} />
                  </div>
                  <p
                    className={cn(
                      "text-[13px] leading-snug",
                      step.status === "completed"
                        ? "text-muted-foreground/35 line-through decoration-muted-foreground/15"
                        : step.status === "inProgress"
                          ? "text-foreground/80"
                          : "text-muted-foreground/55",
                    )}
                  >
                    {step.status === "inProgress" ? (
                      <LoadingText>{step.step}</LoadingText>
                    ) : (
                      step.step
                    )}
                  </p>
                </div>
              ))}
            </div>
          ) : null}

          {/* Proposed Plan Markdown */}
          {planMarkdown ? (
            <div className="space-y-1.5">
              <button
                type="button"
                className="group flex w-full items-center gap-1 text-left"
                onClick={() => setProposedPlanExpanded((v) => !v)}
              >
                {proposedPlanExpanded ? (
                  <ChevronDownIcon className="size-3 shrink-0 text-muted-foreground/30" />
                ) : (
                  <ChevronRightIcon className="size-3 shrink-0 text-muted-foreground/30" />
                )}
                <span className="text-[11px] text-muted-foreground/40 group-hover:text-muted-foreground/60">
                  {planTitle ?? "Full plan"}
                </span>
              </button>
              {proposedPlanExpanded ? (
                <div className="border-l border-border/40 pl-3">
                  <ChatMarkdown
                    text={displayedPlanMarkdown ?? ""}
                    cwd={markdownCwd}
                    isStreaming={false}
                  />
                </div>
              ) : null}
            </div>
          ) : null}

          {/* Empty state */}
          {!activePlan && !planMarkdown ? (
            <p className="py-10 text-center text-[13px] text-muted-foreground/30">No active plan</p>
          ) : null}
        </div>
      </ScrollArea>
    </div>
  );
});

export default PlanSidebar;
export type { PlanSidebarProps };
