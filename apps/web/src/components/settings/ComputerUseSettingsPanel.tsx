import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type {
  ComputerUseAppSnapshot,
  ComputerUseAppWindowSnapshot,
  ComputerUsePermissionKind,
  ComputerUsePermissionSnapshot,
  ComputerUsePermissionsSnapshot,
} from "contracts";
import type { ComputerUseApprovedApp } from "contracts/settings";
import {
  IconCircleCheckOutline24 as CheckCircle2Icon,
  IconEyeOutline24 as EyeIcon,
  IconKeyboardOutline24 as KeyboardIcon,
  IconMonitorOutline24 as MonitorIcon,
  IconCursorPointerOutline24 as MousePointerClickIcon,
  IconRefreshOutline24 as RefreshCwIcon,
  IconShieldOutline24 as ShieldAlertIcon,
  IconShieldCheckOutline24 as ShieldCheckIcon,
} from "nucleo-core-outline-24";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { useComputerUseFeatureEnabled } from "../../featureFlags";
import { useSettings, useUpdateSettings } from "../../hooks/useSettings";
import { ensureNativeApi, readNativeApi } from "../../nativeApi";
import { Alert, AlertDescription, AlertTitle } from "../ui/alert";
import { Button } from "../ui/button";
import { Switch } from "../ui/switch";
import { toastManager } from "../ui/toast";
import {
  createComputerUsePermissionRecheckSchedule,
  isComputerUsePermissionGranted,
  runComputerUsePermissionFlow,
} from "./computerUsePermissionFlow";
import { SettingsPageContainer, SettingsSection, SettingsRow } from "./SettingsPanels";

const COMPUTER_PERMISSIONS_QUERY_KEY = ["computerUse", "permissions"] as const;
const COMPUTER_APPS_QUERY_KEY = ["computerUse", "apps"] as const;

const cardClasses =
  "relative overflow-hidden rounded-2xl border bg-card text-card-foreground shadow-xs/5 not-dark:bg-clip-padding before:pointer-events-none before:absolute before:inset-0 before:rounded-[calc(var(--radius-2xl)-1px)] before:shadow-[0_1px_--theme(--color-black/4%)] dark:before:shadow-[0_-1px_--theme(--color-white/6%)]";

function unavailableComputerUsePermissions(message: string): ComputerUsePermissionsSnapshot {
  return {
    platform: "web",
    supported: false,
    helperAvailable: false,
    helperPath: null,
    checkedAt: new Date().toISOString(),
    message,
    permissions: [
      {
        kind: "accessibility",
        label: "Accessibility",
        state: "unsupported",
        detail: message,
      },
      {
        kind: "screen-recording",
        label: "Screen Recording",
        state: "unsupported",
        detail: message,
      },
    ],
  };
}

function permissionTone(permission: ComputerUsePermissionSnapshot) {
  switch (permission.state) {
    case "granted":
      return {
        label: "Ready",
        dot: "bg-success",
        icon: <ShieldCheckIcon className="size-4 text-success" />,
      };
    case "unsupported":
      return {
        label: "Unavailable",
        dot: "bg-muted-foreground",
        icon: <ShieldAlertIcon className="size-4 text-muted-foreground" />,
      };
    default:
      return {
        label: "Needs permission",
        dot: "bg-warning",
        icon: <ShieldAlertIcon className="size-4 text-warning" />,
      };
  }
}

function PermissionCard({
  permission,
  onPermissionFlow,
  permissionFlowPending,
}: {
  permission: ComputerUsePermissionSnapshot;
  onPermissionFlow: (kind: ComputerUsePermissionKind) => void;
  permissionFlowPending: boolean;
}) {
  const tone = permissionTone(permission);
  const canOpenPermissionFlow =
    permission.state !== "granted" && permission.state !== "unsupported";

  return (
    <div className="flex items-start gap-3 border-t border-border px-4 py-4 first:border-t-0 sm:px-5">
      <div className="mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-full bg-muted/60">
        {tone.icon}
      </div>
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-2">
          <h3 className="text-sm font-medium text-foreground">{permission.label}</h3>
          <span className="inline-flex items-center gap-1.5 rounded-full border border-border/70 px-2 py-0.5 text-[11px] text-muted-foreground">
            <span className={`size-1.5 rounded-full ${tone.dot}`} />
            {tone.label}
          </span>
        </div>
        <p className="mt-1 text-xs leading-relaxed text-muted-foreground">{permission.detail}</p>
      </div>
      {canOpenPermissionFlow ? (
        <Button
          size="sm"
          variant="outline"
          disabled={permissionFlowPending}
          onClick={() => onPermissionFlow(permission.kind)}
        >
          Guide me
        </Button>
      ) : null}
    </div>
  );
}

function CapabilityRail() {
  const items = [
    { icon: MonitorIcon, label: "Screenshots" },
    { icon: MousePointerClickIcon, label: "Pointer" },
    { icon: KeyboardIcon, label: "Keyboard" },
  ];
  return (
    <div className="grid gap-2 pt-3 sm:grid-cols-3">
      {items.map((item) => {
        const Icon = item.icon;
        return (
          <div key={item.label} className="flex items-center gap-2 text-xs text-muted-foreground">
            <Icon className="size-4 text-muted-foreground" />
            <span>{item.label}</span>
          </div>
        );
      })}
    </div>
  );
}

function appPrimaryIdentifier(app: ComputerUseAppSnapshot): string | null {
  return app.bundleIdentifier?.trim() || null;
}

function approvedAppDateLabel(approvedAt: string) {
  const date = new Date(approvedAt);
  if (Number.isNaN(date.getTime())) {
    return approvedAt;
  }
  return date.toLocaleString();
}

function permissionSubjectLabel(snapshot: ComputerUsePermissionsSnapshot | undefined) {
  const subject = snapshot?.permissionSubject;
  const displayName = subject?.displayName?.trim();
  const path = subject?.path?.trim();
  if (displayName && path) {
    return `${displayName} at ${path}`;
  }
  return displayName || path || null;
}

function compactBoundsLabel(bounds: ComputerUseAppWindowSnapshot["bounds"]): string | null {
  if (!bounds) {
    return null;
  }
  return `${Math.round(bounds.width)}x${Math.round(bounds.height)} at ${Math.round(bounds.x)},${Math.round(bounds.y)}`;
}

export function computerUseWindowLabel(
  window: ComputerUseAppWindowSnapshot,
  fallbackIndex: number,
): string {
  const index = Number.isFinite(window.index)
    ? Math.trunc(window.index ?? fallbackIndex)
    : fallbackIndex;
  const title = window.title?.trim() || "Untitled window";
  const bounds = compactBoundsLabel(window.bounds);
  return bounds ? `[${index}] ${title} (${bounds})` : `[${index}] ${title}`;
}

export function computerUseAgentVisibilityStatus(input: {
  readonly enabled: boolean;
  readonly shareWithProviders: boolean;
  readonly requireApproval: boolean;
  readonly approvedAppCount: number;
  readonly permissionsReady: boolean;
}): {
  readonly title: string;
  readonly description: string;
  readonly variant: "info" | "warning" | "success";
} {
  if (!input.enabled) {
    return {
      title: "Agent turns cannot see Computer Use",
      description: "Enable Computer Use to prepare the local macOS helper.",
      variant: "info",
    };
  }
  if (!input.shareWithProviders) {
    return {
      title: "Agent turns cannot see Computer Use yet",
      description:
        "Turn on provider sharing when you want chat agents to receive the Computer Use tools and their screenshot or action results.",
      variant: "warning",
    };
  }
  if (!input.permissionsReady) {
    return {
      title: "Computer Use is shared but permissions are not ready",
      description:
        "Grant Accessibility and Screen Recording before asking an agent to inspect or control the desktop.",
      variant: "warning",
    };
  }
  if (input.approvedAppCount === 0) {
    return {
      title: "Computer Use is shared but no apps are approved",
      description:
        "Approve at least one running app before testing with an agent; provider-facing screenshots and desktop actions stay blocked with an empty allowlist.",
      variant: "warning",
    };
  }
  if (input.requireApproval) {
    return {
      title: "Computer Use is shared with approval prompts",
      description:
        "Supported agents can see Computer Use tools, but some external providers may hide approval-gated desktop tools.",
      variant: "info",
    };
  }
  return {
    title: "Computer Use is visible to supported agents",
    description:
      "Agent turns can receive Computer Use tools and may send screenshots, app context, and action results to the selected provider.",
    variant: "success",
  };
}

function ApprovedAppRow({
  app,
  onRevoke,
}: {
  app: ComputerUseApprovedApp;
  onRevoke: (bundleIdentifier: string) => void;
}) {
  return (
    <div className="flex items-center justify-between gap-3 border-t border-border px-4 py-3 first:border-t-0 sm:px-5">
      <div className="min-w-0">
        <div className="truncate text-sm font-medium text-foreground">{app.name}</div>
        <div className="mt-0.5 truncate text-xs text-muted-foreground">
          {app.bundleIdentifier} - Approved {approvedAppDateLabel(app.approvedAt)}
        </div>
      </div>
      <Button size="sm" variant="outline" onClick={() => onRevoke(app.bundleIdentifier)}>
        <ShieldAlertIcon className="size-3.5" />
        Revoke
      </Button>
    </div>
  );
}

function RunningAppRow({
  app,
  approved,
  onApprove,
  onRevoke,
}: {
  app: ComputerUseAppSnapshot;
  approved: boolean;
  onApprove: (app: ComputerUseAppSnapshot) => void;
  onRevoke: (bundleIdentifier: string) => void;
}) {
  const bundleIdentifier = appPrimaryIdentifier(app);
  const windowCount = app.windows.length;
  const visibleWindows = app.windows.slice(0, 3);
  const hiddenWindowCount = Math.max(0, windowCount - visibleWindows.length);

  return (
    <div className="flex items-start justify-between gap-3 border-t border-border px-4 py-3 first:border-t-0 sm:px-5">
      <div className="min-w-0">
        <div className="flex min-w-0 items-center gap-2">
          <div className="truncate text-sm font-medium text-foreground">{app.name}</div>
          {app.isActive ? (
            <span className="shrink-0 rounded-full border border-success/30 px-2 py-0.5 text-[11px] text-success">
              Active
            </span>
          ) : null}
        </div>
        <div className="mt-0.5 truncate text-xs text-muted-foreground">
          {bundleIdentifier ?? `pid ${app.processIdentifier}`} - {windowCount} window
          {windowCount === 1 ? "" : "s"}
        </div>
        {visibleWindows.length > 0 ? (
          <div className="mt-2 space-y-1">
            {visibleWindows.map((window, index) => (
              <div
                key={`${window.index ?? index}-${window.title ?? "untitled"}`}
                className="truncate text-[11px] text-muted-foreground"
              >
                {computerUseWindowLabel(window, index)}
              </div>
            ))}
            {hiddenWindowCount > 0 ? (
              <div className="text-[11px] text-muted-foreground">
                {hiddenWindowCount} more window{hiddenWindowCount === 1 ? "" : "s"}
              </div>
            ) : null}
          </div>
        ) : null}
      </div>
      {approved && bundleIdentifier ? (
        <Button size="sm" variant="outline" onClick={() => onRevoke(bundleIdentifier)}>
          <ShieldAlertIcon className="size-3.5" />
          Revoke
        </Button>
      ) : (
        <Button
          size="sm"
          variant="outline"
          disabled={!bundleIdentifier}
          onClick={() => onApprove(app)}
        >
          <CheckCircle2Icon className="size-3.5" />
          Approve
        </Button>
      )}
    </div>
  );
}

function ScreenshotPreview() {
  const [imageDataUrl, setImageDataUrl] = useState<string | null>(null);
  const screenshotMutation = useMutation({
    mutationFn: async () => {
      const computer = ensureNativeApi().computer;
      if (!computer) {
        throw new Error("Computer Use is unavailable.");
      }
      return computer.screenshot({});
    },
    onSuccess: (result) => setImageDataUrl(result.imageDataUrl),
    onError: (error) => {
      toastManager.add({
        type: "error",
        title: "Could not capture desktop",
        description: error instanceof Error ? error.message : String(error),
      });
    },
  });

  return (
    <div className={cardClasses}>
      <div className="flex items-center justify-between gap-3 border-b border-border px-4 py-3 sm:px-5">
        <div>
          <h3 className="text-sm font-medium text-foreground">Live desktop preview</h3>
          <p className="mt-0.5 text-xs text-muted-foreground">
            Captures the full visible desktop through the same local macOS helper the agent uses.
          </p>
        </div>
        <Button
          size="sm"
          variant="outline"
          disabled={screenshotMutation.isPending}
          onClick={() => screenshotMutation.mutate()}
        >
          {screenshotMutation.isPending ? (
            <RefreshCwIcon className="size-3.5 animate-spin" />
          ) : (
            <EyeIcon className="size-3.5" />
          )}
          Capture
        </Button>
      </div>
      <div className="bg-muted/30 p-4 sm:p-5">
        {imageDataUrl ? (
          <img
            src={imageDataUrl}
            alt="macOS desktop screenshot"
            className="max-h-[420px] w-full rounded-xl border border-border object-contain shadow-sm"
          />
        ) : (
          <div className="flex min-h-48 items-center justify-center rounded-xl border border-dashed border-border bg-background/70 text-sm text-muted-foreground">
            No screenshot captured yet.
          </div>
        )}
      </div>
    </div>
  );
}

export function ComputerUseSettingsPanel() {
  const settings = useSettings();
  const { updateSettings } = useUpdateSettings();
  const computerUseEnabled = useComputerUseFeatureEnabled();
  const queryClient = useQueryClient();
  const cancelPermissionRecheckRef = useRef<(() => void) | null>(null);
  const [permissionFlowKind, setPermissionFlowKind] = useState<ComputerUsePermissionKind | null>(
    null,
  );

  const fetchComputerUsePermissions = useCallback(async () => {
    if (window.desktopBridge?.getComputerUsePermissions) {
      return window.desktopBridge.getComputerUsePermissions();
    }
    const computer = readNativeApi()?.computer;
    if (!computer) {
      return unavailableComputerUsePermissions(
        "Computer Use is available in the ShioriCode desktop app or a trusted local native API session.",
      );
    }
    return computer.getPermissions();
  }, []);

  const permissionsQuery = useQuery({
    queryKey: COMPUTER_PERMISSIONS_QUERY_KEY,
    queryFn: fetchComputerUsePermissions,
    enabled: true,
    staleTime: 5_000,
    refetchOnWindowFocus: true,
  });

  const appsQuery = useQuery({
    queryKey: COMPUTER_APPS_QUERY_KEY,
    queryFn: async () => {
      const computer = ensureNativeApi().computer;
      if (!computer) {
        throw new Error("Computer Use is unavailable.");
      }
      return computer.listApps({});
    },
    enabled: settings.computerUse.enabled,
    staleTime: 5_000,
    refetchOnWindowFocus: true,
  });

  const grantedCount = useMemo(
    () =>
      permissionsQuery.data?.permissions.filter((permission) => permission.state === "granted")
        .length ?? 0,
    [permissionsQuery.data?.permissions],
  );
  const totalCount = permissionsQuery.data?.permissions.length ?? 2;
  const ready = permissionsQuery.data?.supported === true && grantedCount === totalCount;
  const permissionSubject = permissionSubjectLabel(permissionsQuery.data);
  const approvedApps = settings.computerUse.approvedApps;
  const agentVisibilityStatus = computerUseAgentVisibilityStatus({
    enabled: settings.computerUse.enabled,
    shareWithProviders: settings.computerUse.shareWithProviders,
    requireApproval: settings.computerUse.requireApproval,
    approvedAppCount: approvedApps.length,
    permissionsReady: ready,
  });
  const approvedAppIds = useMemo(
    () => new Set(approvedApps.map((app) => app.bundleIdentifier)),
    [approvedApps],
  );
  const runningApps = useMemo(
    () =>
      appsQuery.data?.apps.filter((app) => app.activationPolicy === "regular").slice(0, 12) ?? [],
    [appsQuery.data?.apps],
  );

  function updateApprovedApps(nextApprovedApps: readonly ComputerUseApprovedApp[]) {
    updateSettings({
      computerUse: {
        ...settings.computerUse,
        approvedApps: [...nextApprovedApps],
      },
    });
  }

  function approveApp(app: ComputerUseAppSnapshot) {
    const bundleIdentifier = appPrimaryIdentifier(app);
    if (!bundleIdentifier) {
      toastManager.add({
        type: "error",
        title: "Cannot approve app",
        description: "This running app does not expose a stable bundle identifier.",
      });
      return;
    }

    updateApprovedApps([
      ...approvedApps.filter((approvedApp) => approvedApp.bundleIdentifier !== bundleIdentifier),
      {
        bundleIdentifier,
        name: app.name,
        approvedAt: new Date().toISOString(),
      },
    ]);
  }

  function revokeApp(bundleIdentifier: string) {
    updateApprovedApps(
      approvedApps.filter((approvedApp) => approvedApp.bundleIdentifier !== bundleIdentifier),
    );
  }

  function cancelPermissionRechecks() {
    cancelPermissionRecheckRef.current?.();
    cancelPermissionRecheckRef.current = null;
  }

  function schedulePermissionRechecks(kind: ComputerUsePermissionKind) {
    cancelPermissionRechecks();
    cancelPermissionRecheckRef.current = createComputerUsePermissionRecheckSchedule({
      kind,
      refresh: async () =>
        queryClient.fetchQuery({
          queryKey: COMPUTER_PERMISSIONS_QUERY_KEY,
          queryFn: fetchComputerUsePermissions,
          staleTime: 0,
        }),
      onGranted: () => {
        cancelPermissionRechecks();
      },
      onError: (error) => {
        console.warn("[computer-use] failed to refresh permission state", error);
      },
    });
  }

  useEffect(() => {
    if (
      permissionFlowKind &&
      isComputerUsePermissionGranted(permissionsQuery.data, permissionFlowKind)
    ) {
      cancelPermissionRechecks();
      setPermissionFlowKind(null);
    }
  }, [permissionFlowKind, permissionsQuery.data]);

  useEffect(() => () => cancelPermissionRechecks(), []);

  async function openPermissionFlow(kind: ComputerUsePermissionKind) {
    setPermissionFlowKind(kind);
    try {
      const request = window.desktopBridge?.requestComputerUsePermission;
      const guide = window.desktopBridge?.showComputerUsePermissionGuide;
      const computer = readNativeApi()?.computer;
      const result = await runComputerUsePermissionFlow(kind, {
        ...(request ? { requestPermission: request } : {}),
        ...(!request && computer ? { requestPermission: computer.requestPermission } : {}),
        ...(guide ? { showPermissionGuide: guide } : {}),
        ...(!guide && computer ? { showPermissionGuide: computer.showPermissionGuide } : {}),
      });
      if (!result?.ok) {
        throw new Error(result?.message ?? "The macOS permission guide could not be opened.");
      }
      schedulePermissionRechecks(kind);
    } catch (error) {
      toastManager.add({
        type: "error",
        title: "Could not open permission guide",
        description: error instanceof Error ? error.message : String(error),
      });
    } finally {
      setPermissionFlowKind(null);
    }
  }

  return (
    <SettingsPageContainer>
      <SettingsSection title="Computer Use" icon={<MonitorIcon className="size-3.5" />}>
        <SettingsRow
          title="Enable Computer Use"
          description="Prepare local macOS desktop screenshots, app context, pointer, keyboard, and scroll tools. Agent chats need provider sharing below."
          control={
            <Switch
              checked={settings.computerUse.enabled}
              onCheckedChange={(checked) =>
                updateSettings({
                  computerUse: {
                    ...settings.computerUse,
                    enabled: Boolean(checked),
                  },
                })
              }
              aria-label="Enable Computer Use"
            />
          }
        />
        <SettingsRow
          title="Require approval for desktop tools"
          description="Ask before an agent runs raw desktop actions; some external providers may hide these tools while approval is required."
          control={
            <Switch
              checked={settings.computerUse.requireApproval}
              onCheckedChange={(checked) =>
                updateSettings({
                  computerUse: {
                    ...settings.computerUse,
                    requireApproval: Boolean(checked),
                  },
                })
              }
              aria-label="Gate direct Computer Use tools"
            />
          }
        />
        <SettingsRow
          title="Share desktop results with agent providers"
          description="Expose Computer Use tools to agent turns. Screenshots, app context, and action results may be sent to the selected provider as tool results."
          control={
            <Switch
              checked={settings.computerUse.shareWithProviders}
              onCheckedChange={(checked) =>
                updateSettings({
                  computerUse: {
                    ...settings.computerUse,
                    shareWithProviders: Boolean(checked),
                  },
                })
              }
              aria-label="Share Computer Use results with providers"
            />
          }
        />
        <Alert variant={agentVisibilityStatus.variant} className="m-4">
          <MonitorIcon />
          <AlertTitle>{agentVisibilityStatus.title}</AlertTitle>
          <AlertDescription>{agentVisibilityStatus.description}</AlertDescription>
        </Alert>
        <Alert variant="info" className="m-4">
          <ShieldCheckIcon />
          <AlertTitle>Local desktop boundary</AlertTitle>
          <AlertDescription>
            The helper runs on this Mac and uses macOS Accessibility and Screen Recording
            permissions. Computer Use tools stay out of agent turns until provider sharing is
            enabled. When sharing is enabled, screenshots, app/window context, and action results
            can be sent to the selected agent provider as tool results. Approved apps limit where
            agents can focus and act, but desktop screenshots are not redacted.
          </AlertDescription>
        </Alert>
      </SettingsSection>

      <SettingsSection title="macOS Permissions" icon={<ShieldCheckIcon className="size-3.5" />}>
        <div className="flex items-center justify-between gap-3 border-b border-border px-4 py-3 sm:px-5">
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <h3 className="text-sm font-medium text-foreground">
                {ready ? "Desktop control is ready" : "Permission checklist"}
              </h3>
              {ready ? <CheckCircle2Icon className="size-4 text-success" /> : null}
            </div>
            <p className="mt-0.5 text-xs text-muted-foreground">
              {permissionsQuery.data?.message ??
                `${grantedCount}/${totalCount} required permissions granted.`}
            </p>
            {permissionSubject ? (
              <p className="mt-0.5 text-xs text-muted-foreground">
                macOS permissions apply to {permissionSubject}.
              </p>
            ) : null}
          </div>
          <Button
            size="icon-sm"
            variant="ghost"
            disabled={permissionsQuery.isFetching}
            onClick={() =>
              void queryClient.invalidateQueries({ queryKey: COMPUTER_PERMISSIONS_QUERY_KEY })
            }
            aria-label="Refresh Computer Use permissions"
          >
            <RefreshCwIcon
              className={`size-3.5 ${permissionsQuery.isFetching ? "animate-spin" : ""}`}
            />
          </Button>
        </div>
        {permissionsQuery.data?.permissions.map((permission) => (
          <PermissionCard
            key={permission.kind}
            permission={permission}
            permissionFlowPending={permissionFlowKind === permission.kind}
            onPermissionFlow={openPermissionFlow}
          />
        ))}
      </SettingsSection>

      <SettingsSection title="Capabilities" icon={<MousePointerClickIcon className="size-3.5" />}>
        <SettingsRow
          title="macOS desktop controls"
          description="The runtime can inspect visible apps and desktop screenshots, then operate the currently focused desktop target."
        >
          <CapabilityRail />
        </SettingsRow>
      </SettingsSection>

      <SettingsSection title="Approved Apps" icon={<ShieldCheckIcon className="size-3.5" />}>
        <div className="flex items-center justify-between gap-3 border-b border-border px-4 py-3 sm:px-5">
          <div className="min-w-0">
            <h3 className="text-sm font-medium text-foreground">App target allowlist</h3>
            <p className="mt-0.5 text-xs text-muted-foreground">
              This local list is used for approvals; agent-facing app lists and actions stay scoped
              to approved bundle IDs.
            </p>
          </div>
          <Button
            size="icon-sm"
            variant="ghost"
            disabled={appsQuery.isFetching}
            onClick={() =>
              void queryClient.invalidateQueries({ queryKey: COMPUTER_APPS_QUERY_KEY })
            }
            aria-label="Refresh running Computer Use apps"
          >
            <RefreshCwIcon className={`size-3.5 ${appsQuery.isFetching ? "animate-spin" : ""}`} />
          </Button>
        </div>

        {approvedApps.length > 0 ? (
          <div>
            <div className="px-4 pb-2 pt-4 text-[11px] font-medium uppercase text-muted-foreground sm:px-5">
              Approved
            </div>
            {approvedApps.map((app) => (
              <ApprovedAppRow key={app.bundleIdentifier} app={app} onRevoke={revokeApp} />
            ))}
          </div>
        ) : (
          <div className="px-4 py-4 text-sm text-muted-foreground sm:px-5">
            No apps approved yet.
          </div>
        )}

        <div className="border-t border-border">
          <div className="px-4 pb-2 pt-4 text-[11px] font-medium uppercase text-muted-foreground sm:px-5">
            Running apps
          </div>
          {appsQuery.isError ? (
            <div className="px-4 pb-4 text-sm text-destructive sm:px-5">
              {appsQuery.error instanceof Error
                ? appsQuery.error.message
                : "Could not load running apps."}
            </div>
          ) : runningApps.length > 0 ? (
            runningApps.map((app) => {
              const bundleIdentifier = appPrimaryIdentifier(app);
              return (
                <RunningAppRow
                  key={bundleIdentifier ?? String(app.processIdentifier)}
                  app={app}
                  approved={bundleIdentifier ? approvedAppIds.has(bundleIdentifier) : false}
                  onApprove={approveApp}
                  onRevoke={revokeApp}
                />
              );
            })
          ) : (
            <div className="px-4 pb-4 text-sm text-muted-foreground sm:px-5">
              {appsQuery.isFetching ? "Loading running apps..." : "No running apps reported."}
            </div>
          )}
        </div>
      </SettingsSection>

      {settings.computerUse.enabled ? <ScreenshotPreview /> : null}
    </SettingsPageContainer>
  );
}
