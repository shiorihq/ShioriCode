import type { ProjectReadFileResult } from "contracts";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  IconCodeOutline24 as CodeIcon,
  IconExternalLinkOutline24 as ExternalLinkIcon,
  IconEyeOutline24 as EyeIcon,
  IconFloppyDiskOutline24 as SaveIcon,
  IconSpinnerLoaderOutline24 as SpinnerIcon,
  IconXmarkOutline24 as XIcon,
} from "nucleo-core-outline-24";
import { useCallback, useEffect, useState } from "react";

import { openInPreferredEditor } from "../editorPreferences";
import { projectQueryKeys, projectReadFileQueryOptions } from "../lib/projectReactQuery";
import { resolvePathLinkTarget } from "../terminal-links";
import { useTheme } from "../hooks/useTheme";
import ChatMarkdown from "./ChatMarkdown";
import {
  DiffPanelEmptyState,
  DiffPanelErrorState,
  DiffPanelLoadingState,
  DiffPanelShell,
  type DiffPanelMode,
} from "./DiffPanelShell";
import { VscodeEntryIcon } from "./chat/VscodeEntryIcon";
import { Button } from "./ui/button";
import { toastManager } from "./ui/toast";
import { Tooltip, TooltipPopup, TooltipTrigger } from "./ui/tooltip";
import { readNativeApi } from "~/nativeApi";
import { cn } from "~/lib/utils";

interface ArtifactPanelProps {
  cwd: string | null;
  mode: DiffPanelMode;
  onClose?: (() => void) | undefined;
  relativePath: string | null;
}

type ArtifactViewMode = "preview" | "source";

const MARKDOWN_EXTENSIONS = new Set([".md", ".mdx", ".markdown"]);

function getLowercaseExtension(relativePath: string): string {
  const basename = relativePath.split("/").pop() ?? relativePath;
  const dotIndex = basename.lastIndexOf(".");
  return dotIndex > 0 ? basename.slice(dotIndex).toLowerCase() : "";
}

function isMarkdownArtifact(data: ProjectReadFileResult): boolean {
  return (
    data.kind === "text" &&
    (data.mimeType === "text/markdown" ||
      MARKDOWN_EXTENSIONS.has(getLowercaseExtension(data.relativePath)))
  );
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const kib = bytes / 1024;
  if (kib < 1024) return `${kib.toFixed(kib >= 10 ? 0 : 1)} KB`;
  const mib = kib / 1024;
  return `${mib.toFixed(mib >= 10 ? 0 : 1)} MB`;
}

function ArtifactPanelHeader(props: {
  canSave: boolean;
  data: ProjectReadFileResult | undefined;
  isDirty: boolean;
  isSaving: boolean;
  onClose?: (() => void) | undefined;
  onOpenInEditor: () => void;
  onSave: () => void;
  onViewModeChange: (mode: ArtifactViewMode) => void;
  relativePath: string | null;
  resolvedTheme: "light" | "dark";
  viewMode: ArtifactViewMode;
}) {
  const {
    canSave,
    data,
    isDirty,
    isSaving,
    onClose,
    onOpenInEditor,
    onSave,
    onViewModeChange,
    relativePath,
    resolvedTheme,
    viewMode,
  } = props;
  const pathLabel = data?.relativePath ?? relativePath ?? "Artifact";

  return (
    <div className="flex min-w-0 items-center gap-2">
      <VscodeEntryIcon
        pathValue={pathLabel}
        kind="file"
        theme={resolvedTheme}
        className="size-4 shrink-0"
      />
      <div className="min-w-0 flex-1">
        <div className="truncate font-mono text-[13px] font-medium text-foreground">
          {pathLabel}
        </div>
        <div className="truncate text-[11px] text-muted-foreground">
          {data ? `${data.kind} · ${formatBytes(data.sizeBytes)}` : "Workspace artifact"}
          {isDirty ? " · unsaved" : ""}
        </div>
      </div>
      {data?.kind === "text" ? (
        <div className="flex shrink-0 items-center rounded-md border border-border/70 bg-background/60 p-0.5">
          <Button
            aria-pressed={viewMode === "preview"}
            className={cn(
              "h-6 gap-1 border-transparent px-2 text-xs shadow-none",
              viewMode === "preview" ? "bg-accent text-foreground" : "text-muted-foreground",
            )}
            size="xs"
            type="button"
            variant="ghost"
            onClick={() => onViewModeChange("preview")}
          >
            <EyeIcon className="size-3.5" />
            Preview
          </Button>
          <Button
            aria-pressed={viewMode === "source"}
            className={cn(
              "h-6 gap-1 border-transparent px-2 text-xs shadow-none",
              viewMode === "source" ? "bg-accent text-foreground" : "text-muted-foreground",
            )}
            size="xs"
            type="button"
            variant="ghost"
            onClick={() => onViewModeChange("source")}
          >
            <CodeIcon className="size-3.5" />
            Source
          </Button>
        </div>
      ) : null}
      <Tooltip>
        <TooltipTrigger
          render={
            <Button
              aria-label="Save artifact"
              disabled={!canSave || isSaving}
              size="icon-xs"
              type="button"
              variant="ghost"
              onClick={onSave}
            >
              {isSaving ? (
                <SpinnerIcon className="size-3.5 animate-spin" />
              ) : (
                <SaveIcon className="size-3.5" />
              )}
            </Button>
          }
        />
        <TooltipPopup side="bottom">Save artifact</TooltipPopup>
      </Tooltip>
      <Tooltip>
        <TooltipTrigger
          render={
            <Button
              aria-label="Open artifact in editor"
              disabled={!relativePath}
              size="icon-xs"
              type="button"
              variant="ghost"
              onClick={onOpenInEditor}
            >
              <ExternalLinkIcon className="size-3.5" />
            </Button>
          }
        />
        <TooltipPopup side="bottom">Open in editor</TooltipPopup>
      </Tooltip>
      {onClose ? (
        <Button
          aria-label="Close artifact panel"
          size="icon-xs"
          type="button"
          variant="ghost"
          onClick={onClose}
        >
          <XIcon className="size-3.5" />
        </Button>
      ) : null}
    </div>
  );
}

function TextArtifactPreview(props: {
  cwd: string | null;
  data: ProjectReadFileResult;
  draft: string;
  viewMode: ArtifactViewMode;
  onDraftChange: (value: string) => void;
}) {
  const { cwd, data, draft, onDraftChange, viewMode } = props;

  if (viewMode === "source") {
    return (
      <textarea
        aria-label="Artifact source editor"
        className="h-full min-h-0 w-full resize-none overflow-auto border-0 bg-transparent p-4 font-mono text-[12.5px] leading-5 text-foreground outline-none selection:bg-primary/20"
        spellCheck={false}
        value={draft}
        onChange={(event) => onDraftChange(event.target.value)}
      />
    );
  }

  if (isMarkdownArtifact(data)) {
    return (
      <div className="h-full min-h-0 overflow-auto px-5 py-4">
        <ChatMarkdown text={draft} cwd={cwd ?? undefined} />
      </div>
    );
  }

  return (
    <pre className="h-full min-h-0 overflow-auto whitespace-pre-wrap break-words p-4 font-mono text-[12.5px] leading-5 text-foreground">
      {draft}
    </pre>
  );
}

function ArtifactBody(props: {
  cwd: string | null;
  data: ProjectReadFileResult;
  draft: string;
  viewMode: ArtifactViewMode;
  onDraftChange: (value: string) => void;
}) {
  const { cwd, data, draft, onDraftChange, viewMode } = props;

  if (data.kind === "text") {
    return (
      <TextArtifactPreview
        cwd={cwd}
        data={data}
        draft={draft}
        viewMode={viewMode}
        onDraftChange={onDraftChange}
      />
    );
  }

  if (data.kind === "image" && data.dataUrl) {
    return (
      <div className="flex h-full min-h-0 items-center justify-center overflow-auto bg-muted/25 p-4">
        <img
          alt={data.relativePath}
          className="max-h-full max-w-full object-contain"
          src={data.dataUrl}
        />
      </div>
    );
  }

  if (data.kind === "pdf" && data.dataUrl) {
    return (
      <object
        aria-label={data.relativePath}
        className="h-full min-h-0 w-full bg-background"
        data={data.dataUrl}
        type="application/pdf"
      >
        <DiffPanelEmptyState
          title="PDF preview unavailable"
          description="Open the artifact in your editor to inspect this PDF."
        />
      </object>
    );
  }

  return (
    <DiffPanelEmptyState
      title="Preview unavailable"
      description={data.reason ?? "This artifact type cannot be previewed yet."}
    />
  );
}

export default function ArtifactPanel({ cwd, mode, onClose, relativePath }: ArtifactPanelProps) {
  const queryClient = useQueryClient();
  const { resolvedTheme } = useTheme();
  const artifactQuery = useQuery(projectReadFileQueryOptions({ cwd, relativePath }));
  const [viewMode, setViewMode] = useState<ArtifactViewMode>("preview");
  const [draft, setDraft] = useState("");
  const data = artifactQuery.data;
  const originalContents = data?.kind === "text" ? (data.contents ?? "") : "";
  const isDirty = data?.kind === "text" && draft !== originalContents;

  useEffect(() => {
    if (data?.kind !== "text") {
      setDraft("");
      setViewMode("preview");
      return;
    }
    setDraft(data.contents ?? "");
    setViewMode((current) => (isMarkdownArtifact(data) ? current : "source"));
  }, [data]);

  useEffect(() => {
    setDraft("");
    setViewMode("preview");
    return () => {
      queryClient.removeQueries({
        queryKey: projectQueryKeys.readFile(cwd, relativePath),
        exact: true,
      });
    };
  }, [cwd, queryClient, relativePath]);

  const saveMutation = useMutation({
    mutationFn: async (contents: string) => {
      const api = readNativeApi();
      if (!api || !cwd || !relativePath) {
        throw new Error("Native API is unavailable.");
      }
      return api.projects.writeFile({ cwd, relativePath, contents });
    },
    onSuccess: async () => {
      await queryClient.invalidateQueries({
        queryKey: projectQueryKeys.readFile(cwd, relativePath),
      });
      toastManager.add({ type: "success", title: "Artifact saved." });
    },
    onError: (error) => {
      toastManager.add({
        type: "error",
        title: "Failed to save artifact.",
        description: error instanceof Error ? error.message : "Unknown error",
      });
    },
  });

  const openArtifactInEditor = useCallback(() => {
    const api = readNativeApi();
    if (!api || !cwd || !relativePath) return;
    const targetPath = resolvePathLinkTarget(relativePath, cwd);
    void openInPreferredEditor(api, targetPath).catch((error) => {
      toastManager.add({
        type: "error",
        title: "Failed to open artifact.",
        description: error instanceof Error ? error.message : "Unknown error",
      });
    });
  }, [cwd, relativePath]);

  const canSave = Boolean(data?.kind === "text" && isDirty && cwd && relativePath);
  const header = (
    <ArtifactPanelHeader
      canSave={canSave}
      data={data}
      isDirty={Boolean(isDirty)}
      isSaving={saveMutation.isPending}
      relativePath={relativePath}
      resolvedTheme={resolvedTheme}
      viewMode={viewMode}
      onClose={onClose}
      onOpenInEditor={openArtifactInEditor}
      onSave={() => saveMutation.mutate(draft)}
      onViewModeChange={setViewMode}
    />
  );

  return (
    <DiffPanelShell mode={mode} header={header}>
      {!cwd || !relativePath ? (
        <DiffPanelEmptyState
          title="No artifact selected"
          description="Open a changed file from the conversation to preview or edit it."
        />
      ) : artifactQuery.isLoading ? (
        <DiffPanelLoadingState label="Loading artifact" />
      ) : artifactQuery.isError ? (
        <DiffPanelErrorState
          title="Unable to load artifact"
          description={
            artifactQuery.error instanceof Error ? artifactQuery.error.message : "Unknown error"
          }
        />
      ) : data ? (
        <ArtifactBody
          cwd={cwd}
          data={data}
          draft={draft}
          viewMode={viewMode}
          onDraftChange={setDraft}
        />
      ) : null}
    </DiffPanelShell>
  );
}
