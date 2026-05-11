import { memo, useState, useId } from "react";
import {
  buildCollapsedProposedPlanPreviewMarkdown,
  buildProposedPlanMarkdownFilename,
  downloadPlanAsTextFile,
  normalizePlanMarkdownForExport,
  proposedPlanTitle,
  stripDisplayedPlanMarkdown,
} from "../../proposedPlan";
import ChatMarkdown from "../ChatMarkdown";
import { IconDotsOutline24 as EllipsisIcon } from "nucleo-core-outline-24";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Menu, MenuItem, MenuPopup, MenuTrigger } from "../ui/menu";
import { cn } from "~/lib/utils";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";
import { toastManager } from "../ui/toast";
import { CHAT_THREAD_BODY_CLASS } from "~/chatTypography";
import { readNativeApi } from "~/nativeApi";
import { useCopyToClipboard } from "~/hooks/useCopyToClipboard";

export const ProposedPlanCard = memo(function ProposedPlanCard({
  planMarkdown,
  cwd,
  workspaceRoot,
}: {
  planMarkdown: string;
  cwd: string | undefined;
  workspaceRoot: string | undefined;
}) {
  const [expanded, setExpanded] = useState(false);
  const [isSaveDialogOpen, setIsSaveDialogOpen] = useState(false);
  const [savePath, setSavePath] = useState("");
  const [isSavingToWorkspace, setIsSavingToWorkspace] = useState(false);
  const { copyToClipboard, isCopied } = useCopyToClipboard({
    onError: (error) => {
      toastManager.add({
        type: "error",
        title: "Could not copy plan",
        description: error instanceof Error ? error.message : "An error occurred while copying.",
      });
    },
  });
  const savePathInputId = useId();
  const title = proposedPlanTitle(planMarkdown) ?? "Proposed plan";
  const lineCount = planMarkdown.split("\n").length;
  const canCollapse = planMarkdown.length > 900 || lineCount > 20;
  const displayedPlanMarkdown = stripDisplayedPlanMarkdown(planMarkdown);
  const collapsedPreview = canCollapse
    ? buildCollapsedProposedPlanPreviewMarkdown(planMarkdown, { maxLines: 10 })
    : null;
  const downloadFilename = buildProposedPlanMarkdownFilename(planMarkdown);
  const saveContents = normalizePlanMarkdownForExport(planMarkdown);

  const handleDownload = () => {
    downloadPlanAsTextFile(downloadFilename, saveContents);
  };

  const handleCopyPlan = () => {
    copyToClipboard(saveContents);
  };

  const openSaveDialog = () => {
    if (!workspaceRoot) {
      toastManager.add({
        type: "error",
        title: "Workspace path is unavailable",
        description: "This thread does not have a workspace path to save into.",
      });
      return;
    }
    setSavePath((existing) => (existing.length > 0 ? existing : downloadFilename));
    setIsSaveDialogOpen(true);
  };

  const handleSaveToWorkspace = () => {
    const api = readNativeApi();
    const relativePath = savePath.trim();
    if (!api || !workspaceRoot) {
      return;
    }
    if (!relativePath) {
      toastManager.add({
        type: "warning",
        title: "Enter a workspace path",
      });
      return;
    }

    setIsSavingToWorkspace(true);
    void api.projects
      .writeFile({
        cwd: workspaceRoot,
        relativePath,
        contents: saveContents,
      })
      .then((result) => {
        setIsSaveDialogOpen(false);
        toastManager.add({
          type: "success",
          title: "Plan saved to workspace",
          description: result.relativePath,
        });
      })
      .catch((error) => {
        toastManager.add({
          type: "error",
          title: "Could not save plan",
          description: error instanceof Error ? error.message : "An error occurred while saving.",
        });
      })
      .then(
        () => {
          setIsSavingToWorkspace(false);
        },
        () => {
          setIsSavingToWorkspace(false);
        },
      );
  };

  return (
    <div className="border-l-2 border-primary/25 pl-4">
      <div className="flex items-center justify-between gap-2">
        <p className={cn(CHAT_THREAD_BODY_CLASS, "truncate font-medium text-foreground")}>
          {title}
        </p>
        <Menu>
          <MenuTrigger
            render={
              <Button
                aria-label="Plan actions"
                size="icon-xs"
                variant="ghost"
                className="shrink-0 text-muted-foreground/40 hover:text-muted-foreground/70"
              />
            }
          >
            <EllipsisIcon aria-hidden="true" className="size-3.5" />
          </MenuTrigger>
          <MenuPopup align="end">
            <MenuItem onClick={handleCopyPlan}>
              {isCopied ? "Copied!" : "Copy to clipboard"}
            </MenuItem>
            <MenuItem onClick={handleDownload}>Download as markdown</MenuItem>
            <MenuItem onClick={openSaveDialog} disabled={!workspaceRoot || isSavingToWorkspace}>
              Save to workspace
            </MenuItem>
          </MenuPopup>
        </Menu>
      </div>
      <div className="mt-2">
        <div className={cn("relative", canCollapse && !expanded && "max-h-80 overflow-hidden")}>
          {canCollapse && !expanded ? (
            <ChatMarkdown text={collapsedPreview ?? ""} cwd={cwd} isStreaming={false} />
          ) : (
            <ChatMarkdown text={displayedPlanMarkdown} cwd={cwd} isStreaming={false} />
          )}
          {canCollapse && !expanded ? (
            <div className="pointer-events-none absolute inset-x-0 bottom-0 h-16 bg-linear-to-t from-background via-background/80 to-transparent" />
          ) : null}
        </div>
        {canCollapse ? (
          <button
            type="button"
            data-scroll-anchor-ignore
            onClick={() => setExpanded((value) => !value)}
            className="mt-2 text-xs text-muted-foreground/50 transition-colors hover:text-muted-foreground/80"
          >
            {expanded ? "Show less" : "Show more"}
          </button>
        ) : null}
      </div>

      <Dialog
        open={isSaveDialogOpen}
        onOpenChange={(open) => {
          if (!isSavingToWorkspace) {
            setIsSaveDialogOpen(open);
          }
        }}
      >
        <DialogPopup className="max-w-xl">
          <DialogHeader>
            <DialogTitle>Save plan to workspace</DialogTitle>
            <DialogDescription>
              Enter a path relative to <code>{workspaceRoot ?? "the workspace"}</code>.
            </DialogDescription>
          </DialogHeader>
          <DialogPanel className="space-y-3">
            <label htmlFor={savePathInputId} className="grid gap-1.5">
              <span className={cn(CHAT_THREAD_BODY_CLASS, "font-medium text-foreground")}>
                Workspace path
              </span>
              <Input
                id={savePathInputId}
                value={savePath}
                onChange={(event) => setSavePath(event.target.value)}
                placeholder={downloadFilename}
                spellCheck={false}
                disabled={isSavingToWorkspace}
              />
            </label>
          </DialogPanel>
          <DialogFooter>
            <Button
              variant="outline"
              size="sm"
              onClick={() => setIsSaveDialogOpen(false)}
              disabled={isSavingToWorkspace}
            >
              Cancel
            </Button>
            <Button
              size="sm"
              onClick={() => void handleSaveToWorkspace()}
              disabled={isSavingToWorkspace}
            >
              {isSavingToWorkspace ? "Saving..." : "Save"}
            </Button>
          </DialogFooter>
        </DialogPopup>
      </Dialog>
    </div>
  );
});
