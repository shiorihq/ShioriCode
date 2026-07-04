import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type {
  ComputerUsePermissionKind,
  ComputerUsePermissionSnapshot,
  ComputerUsePermissionsSnapshot,
} from "contracts";
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

function permissionSubjectLabel(snapshot: ComputerUsePermissionsSnapshot | undefined) {
  const subject = snapshot?.permissionSubject;
  const displayName = subject?.displayName?.trim();
  const path = subject?.path?.trim();
  if (displayName && path) {
    return `${displayName} at ${path}`;
  }
  return displayName || path || null;
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

  const grantedCount = useMemo(
    () =>
      permissionsQuery.data?.permissions.filter((permission) => permission.state === "granted")
        .length ?? 0,
    [permissionsQuery.data?.permissions],
  );
  const totalCount = permissionsQuery.data?.permissions.length ?? 2;
  const ready = permissionsQuery.data?.supported === true && grantedCount === totalCount;
  const permissionSubject = permissionSubjectLabel(permissionsQuery.data);

  function setComputerUseEnabled(enabled: boolean) {
    if (enabled === settings.computerUse.enabled) {
      return;
    }
    updateSettings({ computerUse: { enabled } });
    // Provider sessions cache their tool surface; refresh so the Computer Use
    // tools appear or disappear without restarting the session.
    void readNativeApi()
      ?.server.refreshProviders()
      .catch((error) => {
        console.warn("[computer-use] failed to refresh providers after settings change", error);
      });
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
          description="Let agents see and control this Mac: desktop screenshots, app context, pointer, keyboard, and scroll. Screenshots and action results are sent to the selected agent provider as tool results."
          control={
            <Switch
              checked={settings.computerUse.enabled}
              onCheckedChange={(checked) => setComputerUseEnabled(Boolean(checked))}
              aria-label="Enable Computer Use"
            />
          }
        >
          <CapabilityRail />
        </SettingsRow>
        <Alert variant="info" className="m-4">
          <ShieldCheckIcon />
          <AlertTitle>Local desktop boundary</AlertTitle>
          <AlertDescription>
            The helper runs on this Mac and uses macOS Accessibility and Screen Recording
            permissions. While enabled, agents have full access to the visible desktop.
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

      {settings.computerUse.enabled ? <ScreenshotPreview /> : null}
    </SettingsPageContainer>
  );
}
