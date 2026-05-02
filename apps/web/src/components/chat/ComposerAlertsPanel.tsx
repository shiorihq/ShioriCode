import { PROVIDER_DISPLAY_NAMES, type ServerProvider } from "contracts";
import type { OrchestrationThreadResumeState } from "contracts";
import {
  AlertTriangleIcon,
  ChevronDownIcon,
  ChevronUpIcon,
  Loader2Icon,
  RefreshCwIcon,
  SettingsIcon,
  XIcon,
} from "lucide-react";
import { memo, useState } from "react";
import { Link } from "@tanstack/react-router";

import { cn } from "~/lib/utils";
import { AnimatedExpandPanel } from "../ui/AnimatedExpandPanel";
import { Button } from "../ui/button";

/* ── Alert icon (colored, no background tint) ── */

function AlertIcon({ variant }: { variant: "error" | "warning" | "info" }) {
  return (
    <AlertTriangleIcon
      className={cn(
        "size-3 shrink-0",
        variant === "error" && "text-destructive",
        variant === "warning" && "text-warning",
        variant === "info" && "text-info",
      )}
    />
  );
}

/* ── Collapsible alert row ── */

interface ComposerAlertRowProps {
  icon: React.ReactNode;
  title: string;
  variant: "error" | "warning" | "info";
  action?: React.ReactNode;
  onDismiss?: (() => void) | undefined;
  children: React.ReactNode;
}

const ComposerAlertRow = memo(function ComposerAlertRow({
  icon,
  title,
  variant: _variant,
  action,
  onDismiss,
  children,
}: ComposerAlertRowProps) {
  const [expanded, setExpanded] = useState(false);

  return (
    <div className="border-t border-border/30 first:border-t-0">
      <div className="flex items-start gap-2.5 px-4 py-2.5">
        <span className="flex h-[18px] shrink-0 items-center">{icon}</span>
        <div className="min-w-0 flex-1">
          <button
            type="button"
            onClick={() => setExpanded((v) => !v)}
            className="flex w-full cursor-pointer items-center gap-2 text-left focus-visible:outline-none"
            aria-expanded={expanded}
          >
            <span
              className={cn(
                "text-[12.5px] font-medium",
                _variant === "error" ? "text-destructive" : "text-foreground/85",
              )}
            >
              {title}
            </span>
            <span className="inline-flex size-4 shrink-0 items-center justify-center text-muted-foreground/50">
              {expanded ? (
                <ChevronUpIcon className="size-3" />
              ) : (
                <ChevronDownIcon className="size-3" />
              )}
            </span>
          </button>
          <AnimatedExpandPanel open={expanded} fade>
            <div className="pt-1.5 text-[11.5px] leading-relaxed text-muted-foreground/70">
              {children}
            </div>
          </AnimatedExpandPanel>
        </div>
        <div className="flex shrink-0 items-center gap-1">
          {action ? <div className="flex items-center">{action}</div> : null}
          {onDismiss ? (
            <button
              type="button"
              aria-label="Dismiss"
              className="inline-flex size-5 items-center justify-center rounded-sm text-muted-foreground/40 transition-colors hover:text-destructive"
              onClick={onDismiss}
            >
              <XIcon className="size-3" />
            </button>
          ) : null}
        </div>
      </div>
    </div>
  );
});

/* ── Individual alert types ── */

const ComposerProviderStatusAlert = memo(function ComposerProviderStatusAlert({
  status,
}: {
  status: ServerProvider | null;
}) {
  if (!status || status.status === "ready" || status.status === "disabled") {
    return null;
  }

  const providerLabel = PROVIDER_DISPLAY_NAMES[status.provider] ?? status.provider;
  const defaultMessage =
    status.status === "error"
      ? `${providerLabel} provider is unavailable.`
      : `${providerLabel} provider has limited availability.`;
  const title = `${providerLabel} provider status`;
  const variant = status.status === "error" ? "error" : "warning";

  return (
    <ComposerAlertRow
      icon={<AlertIcon variant={variant} />}
      title={title}
      variant={variant}
      action={
        <Link
          to="/settings/general"
          className="inline-flex items-center gap-1 rounded-md text-[11px] font-medium text-muted-foreground/60 underline-offset-2 hover:text-foreground hover:underline"
        >
          <SettingsIcon className="size-3" />
          Settings
        </Link>
      }
    >
      {status.message ?? defaultMessage}
    </ComposerAlertRow>
  );
});

const ComposerThreadErrorAlert = memo(function ComposerThreadErrorAlert({
  error,
  onDismiss,
}: {
  error: string | null;
  onDismiss?: (() => void) | undefined;
}) {
  if (!error) return null;
  return (
    <ComposerAlertRow
      icon={<AlertIcon variant="error" />}
      title="Something went wrong"
      variant="error"
      onDismiss={onDismiss}
    >
      {error}
    </ComposerAlertRow>
  );
});

function resumeBannerCopy(resumeState: OrchestrationThreadResumeState): {
  title: string;
  description: string;
  variant: "warning" | "error";
  action?: { label: string; action: "resume" };
} | null {
  switch (resumeState) {
    case "resuming":
      return {
        title: "Restoring thread runtime",
        description: "ShioriCode is reconnecting this thread's provider session.",
        variant: "warning",
      };
    case "needs_resume":
      return {
        title: "Thread needs resume",
        description: "The provider session is no longer attached. Send a message to restore it.",
        variant: "warning",
        action: { label: "Resume", action: "resume" },
      };
    case "unrecoverable":
      return {
        title: "Thread session cannot be restored",
        description:
          "This provider session could not be resumed automatically. Start a new turn to continue safely.",
        variant: "error",
        action: { label: "Start new turn", action: "resume" },
      };
    case "resumed":
    default:
      return null;
  }
}

const ComposerThreadResumeAlert = memo(function ComposerThreadResumeAlert({
  resumeState,
  onResumeAction,
}: {
  resumeState: OrchestrationThreadResumeState;
  onResumeAction?: () => void;
}) {
  const copy = resumeBannerCopy(resumeState);
  if (!copy) {
    return null;
  }

  const isResuming = resumeState === "resuming";

  return (
    <ComposerAlertRow
      icon={
        isResuming ? (
          <Loader2Icon className="mt-[3px] size-3.5 animate-spin text-warning" />
        ) : (
          <AlertIcon variant={copy.variant} />
        )
      }
      title={copy.title}
      variant={copy.variant}
      action={
        copy.action && onResumeAction ? (
          <Button
            variant="outline"
            size="sm"
            className={cn(
              "h-6 px-2 text-[11px]",
              copy.variant === "error"
                ? "border-destructive/20 text-destructive/80 hover:border-destructive/30 hover:bg-destructive/[0.04] hover:text-destructive"
                : "border-border/50 hover:bg-muted/40",
            )}
            onClick={(e) => {
              e.stopPropagation();
              onResumeAction();
            }}
          >
            {copy.action.action === "resume" && <RefreshCwIcon className="mr-1 size-3" />}
            {copy.action.label}
          </Button>
        ) : undefined
      }
    >
      {copy.description}
    </ComposerAlertRow>
  );
});

/* ── Panel container (matches ComposerContextPanel architecture) ── */

export interface ComposerAlertsPanelProps {
  providerStatus: ServerProvider | null;
  resumeState: OrchestrationThreadResumeState;
  threadError: string | null;
  onDismissError: () => void;
  onResumeAction: () => void;
}

export const ComposerAlertsPanel = memo(function ComposerAlertsPanel({
  providerStatus,
  resumeState,
  threadError,
  onDismissError,
  onResumeAction,
}: ComposerAlertsPanelProps) {
  const hasProviderAlert =
    providerStatus != null &&
    providerStatus.status !== "ready" &&
    providerStatus.status !== "disabled";
  const hasResumeAlert = resumeState !== "resumed";
  const hasErrorAlert = threadError != null;

  if (!hasProviderAlert && !hasResumeAlert && !hasErrorAlert) {
    return null;
  }

  return (
    <div className="relative z-0">
      <div
        className={cn(
          "mx-auto w-[calc(100%-3rem)] max-w-[39rem] min-w-0 overflow-hidden rounded-t-[16px] rounded-b-none border border-b-0 border-border bg-card sm:w-[calc(100%-4rem)]",
        )}
        data-chat-composer-alerts-panel="true"
      >
        <ComposerProviderStatusAlert status={providerStatus} />
        <ComposerThreadResumeAlert resumeState={resumeState} onResumeAction={onResumeAction} />
        <ComposerThreadErrorAlert error={threadError} onDismiss={onDismissError} />
      </div>
    </div>
  );
});
