import type { ReactNode } from "react";

import { isElectron } from "~/env";
import { cn } from "~/lib/utils";

import { LoadingText } from "./ui/loading-text";
import { Skeleton } from "./ui/skeleton";
import { Spinner } from "./ui/spinner";

export type DiffPanelMode = "inline" | "sheet" | "sidebar";

function getDiffPanelHeaderRowClassName(mode: DiffPanelMode) {
  const shouldUseDragRegion = isElectron && mode !== "sheet";
  return cn(
    "flex items-center justify-between gap-2 px-4",
    shouldUseDragRegion ? "drag-region h-[52px] border-b border-border" : "h-12",
  );
}

export function DiffPanelShell(props: {
  mode: DiffPanelMode;
  header: ReactNode;
  children: ReactNode;
}) {
  const shouldUseDragRegion = isElectron && props.mode !== "sheet";

  return (
    <div
      className={cn(
        "@container/diff-panel flex h-full min-w-0 flex-col overflow-hidden bg-background",
        props.mode === "inline"
          ? "w-[42vw] min-w-[360px] max-w-[560px] shrink-0 border-l border-border"
          : "w-full",
      )}
    >
      {shouldUseDragRegion ? (
        <div className={getDiffPanelHeaderRowClassName(props.mode)}>{props.header}</div>
      ) : (
        <div className="border-b border-border">
          <div className={getDiffPanelHeaderRowClassName(props.mode)}>{props.header}</div>
        </div>
      )}
      {props.children}
    </div>
  );
}

export function DiffPanelHeaderSkeleton() {
  return (
    <>
      <div className="relative min-w-0 flex-1">
        <Skeleton className="absolute left-0 top-1/2 size-6 -translate-y-1/2 rounded-md border border-border/50" />
        <Skeleton className="absolute right-0 top-1/2 size-6 -translate-y-1/2 rounded-md border border-border/50" />
        <div className="flex gap-1 overflow-hidden px-8 py-0.5">
          <Skeleton className="h-6 w-16 shrink-0 rounded-md" />
          <Skeleton className="h-6 w-24 shrink-0 rounded-md" />
          <Skeleton className="h-6 w-24 shrink-0 rounded-md max-sm:hidden" />
        </div>
      </div>
      <div className="flex shrink-0 gap-1">
        <Skeleton className="size-7 rounded-md" />
        <Skeleton className="size-7 rounded-md" />
      </div>
    </>
  );
}

export function DiffPanelLoadingState(props: { label: string }) {
  return (
    <div className="relative flex min-h-0 flex-1 overflow-hidden p-2">
      <div
        aria-hidden="true"
        className="relative min-h-0 flex-1 overflow-hidden rounded-md border border-border/60 bg-card/30"
      >
        <div className="absolute inset-0 bg-linear-to-br from-background/25 via-transparent to-primary/5" />
        <div className="absolute inset-0 scale-[1.015] blur-[3px]">
          <div className="flex items-center gap-2 border-b border-border/50 px-3 py-2">
            <div className="h-4 w-28 rounded-full bg-foreground/[0.08]" />
            <div className="ml-auto h-4 w-16 rounded-full bg-foreground/[0.07]" />
          </div>
          <div className="space-y-5 px-4 py-4 opacity-75">
            <DiffPanelLoadingPreviewBlock
              accentClassName="bg-sky-400/45"
              rows={[
                { id: "header", width: "72%" },
                { id: "context-1", width: "58%", indent: "8%" },
                { id: "context-2", width: "64%", indent: "4%" },
                { id: "context-3", width: "46%", indent: "16%" },
              ]}
            />
            <DiffPanelLoadingPreviewBlock
              accentClassName="bg-emerald-400/45"
              rows={[
                { id: "header", width: "68%" },
                { id: "addition-1", width: "84%", indent: "6%" },
                { id: "addition-2", width: "56%", indent: "12%" },
                { id: "addition-3", width: "74%", indent: "4%" },
              ]}
            />
            <DiffPanelLoadingPreviewBlock
              accentClassName="bg-rose-400/40"
              rows={[
                { id: "header", width: "62%" },
                { id: "deletion-1", width: "52%", indent: "10%" },
                { id: "deletion-2", width: "79%", indent: "2%" },
                { id: "deletion-3", width: "48%", indent: "14%" },
              ]}
            />
          </div>
        </div>
      </div>
      <DiffPanelLoadingOverlay label={props.label} className="inset-2 rounded-md" />
    </div>
  );
}

export function DiffPanelEmptyState(props: { title: string; description: string }) {
  return (
    <div className="flex min-h-0 flex-1 items-center justify-center p-6 text-center">
      <div className="max-w-sm space-y-1.5">
        <p className="text-sm font-medium text-foreground">{props.title}</p>
        <p className="text-sm text-muted-foreground">{props.description}</p>
      </div>
    </div>
  );
}

export function DiffPanelErrorState(props: { title: string; description: string }) {
  return (
    <div className="flex min-h-0 flex-1 items-center justify-center p-6 text-center">
      <div className="max-w-sm space-y-1.5 rounded-md border border-destructive/30 bg-destructive/5 px-4 py-3">
        <p className="text-sm font-medium text-destructive">{props.title}</p>
        <p className="break-words text-sm text-muted-foreground">{props.description}</p>
      </div>
    </div>
  );
}

function DiffPanelLoadingPreviewBlock(props: {
  accentClassName: string;
  rows: ReadonlyArray<{
    id: string;
    width: string;
    indent?: string;
  }>;
}) {
  return (
    <div className="rounded-md border border-border/35 bg-background/55 p-3">
      <div className="space-y-2">
        {props.rows.map((row) => (
          <div key={row.id} className="flex items-center gap-3">
            <div className={cn("h-5 w-1 rounded-full", props.accentClassName)} />
            <div
              className="h-2.5 rounded-full bg-foreground/[0.08]"
              style={{ marginLeft: row.indent ?? "0%", width: row.width }}
            />
          </div>
        ))}
      </div>
    </div>
  );
}

export function DiffPanelLoadingOverlay(props: { label: string; className?: string }) {
  return (
    <div
      className={cn(
        "pointer-events-none absolute inset-0 z-10 flex items-center justify-center bg-card/55 backdrop-blur-sm",
        props.className,
      )}
      role="status"
      aria-live="polite"
      aria-label={props.label}
    >
      <p className="flex items-center gap-1.5 text-sm text-muted-foreground">
        <Spinner className="size-3.5" />
        <LoadingText>{props.label}</LoadingText>
      </p>
    </div>
  );
}
