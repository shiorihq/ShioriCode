import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { ComputerUsePermissionKind, ComputerUsePermissionSnapshot } from "contracts";
import {
  CheckCircle2Icon,
  EyeIcon,
  KeyboardIcon,
  MonitorIcon,
  MousePointerClickIcon,
  RefreshCwIcon,
  ShieldAlertIcon,
  ShieldCheckIcon,
} from "lucide-react";
import { useMemo, useState } from "react";

import { useHostedShioriState } from "../../convex/HostedShioriProvider";
import { useSettings, useUpdateSettings } from "../../hooks/useSettings";
import { ensureNativeApi } from "../../nativeApi";
import { Alert, AlertDescription, AlertTitle } from "../ui/alert";
import { Button } from "../ui/button";
import { Switch } from "../ui/switch";
import { toastManager } from "../ui/toast";
import { SettingsPageContainer, SettingsSection, SettingsRow } from "./SettingsPanels";

const COMPUTER_PERMISSIONS_QUERY_KEY = ["computerUse", "permissions"] as const;

const cardClasses =
  "relative overflow-hidden rounded-2xl border bg-card text-card-foreground shadow-xs/5 not-dark:bg-clip-padding before:pointer-events-none before:absolute before:inset-0 before:rounded-[calc(var(--radius-2xl)-1px)] before:shadow-[0_1px_--theme(--color-black/4%)] dark:before:shadow-[0_-1px_--theme(--color-white/6%)]";

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
  onGuide,
  guidePending,
}: {
  permission: ComputerUsePermissionSnapshot;
  onGuide: (kind: ComputerUsePermissionKind) => void;
  guidePending: boolean;
}) {
  const tone = permissionTone(permission);
  const canGuide = permission.state !== "granted" && permission.state !== "unsupported";

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
      {canGuide ? (
        <Button
          size="sm"
          variant="outline"
          disabled={guidePending}
          onClick={() => onGuide(permission.kind)}
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
            Captures the main display through the same helper the agent uses.
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
  const { computerUseEnabled } = useHostedShioriState();
  const queryClient = useQueryClient();
  const [guideKind, setGuideKind] = useState<ComputerUsePermissionKind | null>(null);

  const permissionsQuery = useQuery({
    queryKey: COMPUTER_PERMISSIONS_QUERY_KEY,
    queryFn: async () => {
      if (window.desktopBridge?.getComputerUsePermissions) {
        return window.desktopBridge.getComputerUsePermissions();
      }
      const computer = ensureNativeApi().computer;
      if (!computer) {
        throw new Error("Computer Use is unavailable.");
      }
      return computer.getPermissions();
    },
    enabled: computerUseEnabled,
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

  async function showPermissionGuide(kind: ComputerUsePermissionKind) {
    const guide = window.desktopBridge?.showComputerUsePermissionGuide;
    const computer = ensureNativeApi().computer;
    setGuideKind(kind);
    try {
      const result = guide
        ? { ok: await guide(kind), message: null }
        : await computer?.showPermissionGuide({ kind });
      if (!result?.ok) {
        throw new Error("The macOS permission guide could not be opened.");
      }
      setTimeout(() => {
        void queryClient.invalidateQueries({ queryKey: COMPUTER_PERMISSIONS_QUERY_KEY });
      }, 1200);
    } catch (error) {
      toastManager.add({
        type: "error",
        title: "Could not open permission guide",
        description: error instanceof Error ? error.message : String(error),
      });
    } finally {
      setGuideKind(null);
    }
  }

  return (
    <SettingsPageContainer>
      <SettingsSection title="Computer Use" icon={<MonitorIcon className="size-3.5" />}>
        {!computerUseEnabled ? (
          <Alert variant="warning" className="m-4">
            <MonitorIcon />
            <AlertTitle>Computer Use disabled</AlertTitle>
            <AlertDescription>
              Computer Use is currently disabled for this Shiori deployment.
            </AlertDescription>
          </Alert>
        ) : null}
        <SettingsRow
          title="Enable Computer Use"
          description="Expose macOS desktop screenshot, pointer, keyboard, and scroll tools to supported agents."
          control={
            <Switch
              checked={computerUseEnabled && settings.computerUse.enabled}
              disabled={!computerUseEnabled}
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
          title="Gate direct desktop tools"
          description="Keep raw MCP desktop actions hidden unless the approval gate is disabled."
          control={
            <Switch
              checked={settings.computerUse.requireApproval}
              disabled={!computerUseEnabled}
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
      </SettingsSection>

      {computerUseEnabled ? (
        <>
          <SettingsSection
            title="macOS Permissions"
            icon={<ShieldCheckIcon className="size-3.5" />}
          >
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
                guidePending={guideKind === permission.kind}
                onGuide={showPermissionGuide}
              />
            ))}
          </SettingsSection>

          <SettingsSection
            title="Capabilities"
            icon={<MousePointerClickIcon className="size-3.5" />}
          >
            <SettingsRow
              title="macOS desktop controls"
              description="The runtime can inspect the main display and operate the currently focused desktop target."
            >
              <CapabilityRail />
            </SettingsRow>
          </SettingsSection>
        </>
      ) : null}

      {computerUseEnabled && settings.computerUse.enabled ? <ScreenshotPreview /> : null}
    </SettingsPageContainer>
  );
}
