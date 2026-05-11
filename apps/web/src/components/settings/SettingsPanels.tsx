import {
  IconArchiveOutline24 as ArchiveIcon,
  IconArchiveOutline24 as ArchiveX,
  IconChevronDownOutline24 as ChevronDownIcon,
  IconInfoPointOutline24 as InfoIcon,
  IconRefreshOutline24 as RefreshCwIcon,
  IconTrash2Outline24 as Trash2,
  IconUndoOutline24 as Undo2Icon,
  IconXmarkOutline24 as XIcon,
} from "nucleo-core-outline-24";
import { useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  type DesktopCompanionCliState,
  type OnboardingStepId,
  PROVIDER_DISPLAY_NAMES,
  type ProviderKind,
  type ServerProvider,
  type ServerProviderModel,
  ThreadId,
} from "contracts";
import {
  DEFAULT_ASSISTANT_PERSONALITY,
  DEFAULT_CODE_FONT_FAMILY,
  DEFAULT_UI_FONT_FAMILY,
  DEFAULT_UNIFIED_SETTINGS,
  type UnifiedSettings,
} from "contracts/settings";
import { resolveOnboardingState } from "shared/onboarding";
import { Equal } from "effect";
import { APP_VERSION } from "../../branding";
import { ASSISTANT_PERSONALITY_OPTIONS } from "../../assistantPersonalityOptions";
import {
  canCheckForUpdate,
  getDesktopUpdateButtonTooltip,
  getDesktopUpdateInstallConfirmationMessage,
  isDesktopUpdateButtonDisabled,
  resolveDesktopUpdateButtonAction,
} from "../../components/desktopUpdate.logic";
import { ProviderModelPicker } from "../chat/ProviderModelPicker";
import { TraitsPicker } from "../chat/TraitsPicker";
import { resolveAndPersistPreferredEditor } from "../../editorPreferences";
import { isElectron } from "../../env";
import { useSettings, useUpdateSettings } from "../../hooks/useSettings";
import { useThreadActions } from "../../hooks/useThreadActions";
import { getPersonalDetailsBlurClass, shouldBlurEmailMention } from "../../lib/personalDetails";
import {
  flattenHostedShioriSettingsModels,
  useMergedServerProviders,
} from "../../convex/shioriProvider";
import { useHostedShioriState } from "../../convex/HostedShioriProvider";
import {
  setDesktopUpdateStateQueryData,
  useDesktopUpdateState,
} from "../../lib/desktopUpdateReactQuery";
import {
  buildProviderModelSelection,
  getCustomModelOptionsByProvider,
  resolveAppModelSelectionState,
  resolveConfigurableModelSelectionState,
} from "../../modelSelection";
import { ensureNativeApi, readNativeApi } from "../../nativeApi";
import { useStore } from "../../store";
import { formatRelativeTime, formatRelativeTimeLabel } from "../../timestampFormat";
import { cn } from "../../lib/utils";
import { HostedShioriAuthPanel } from "../auth/HostedShioriAuthPanel";
import { Button } from "../ui/button";
import { Checkbox } from "../ui/checkbox";
import { Collapsible, CollapsibleContent } from "../ui/collapsible";
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "../ui/empty";
import { Input } from "../ui/input";
import { LoadingText } from "../ui/loading-text";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { Switch } from "../ui/switch";
import { toastManager } from "../ui/toast";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { ProjectFavicon } from "../ProjectFavicon";
import {
  useServerAvailableEditors,
  useServerKeybindingsConfigPath,
  useServerProviders,
} from "../../rpc/serverState";

export const TIMESTAMP_FORMAT_LABELS = {
  locale: "System default",
  "12-hour": "12-hour",
  "24-hour": "24-hour",
} as const;

type FontOption = {
  value: string;
  label: string;
};

export const DEFAULT_UI_FONT_OPTION: FontOption = {
  value: DEFAULT_UI_FONT_FAMILY,
  label: "System Sans",
};

export const DEFAULT_CODE_FONT_OPTION: FontOption = {
  value: DEFAULT_CODE_FONT_FAMILY,
  label: "System Monospace",
};

export function buildFontOptions(
  fontFamilies: readonly string[],
  currentValue: string,
  defaultOption: FontOption,
): FontOption[] {
  const options = [
    defaultOption,
    ...fontFamilies.map((fontFamily) => ({
      value: fontFamily,
      label: fontFamily,
    })),
  ];

  if (
    currentValue !== defaultOption.value &&
    !options.some((option) => option.value === currentValue)
  ) {
    options.push({
      value: currentValue,
      label: currentValue,
    });
  }

  return options;
}

export function filterFontOptions(options: readonly FontOption[], query: string): FontOption[] {
  const normalizedQuery = query.trim().toLocaleLowerCase();
  if (normalizedQuery.length === 0) {
    return [...options];
  }

  return options.filter((option) => option.label.toLocaleLowerCase().includes(normalizedQuery));
}

type InstallProviderSettings = {
  provider: ProviderKind;
  title: string;
  textFields?: readonly ProviderSettingsTextField[];
  homePathKey?: "codexHomePath";
  homePlaceholder?: string;
  homeDescription?: ReactNode;
};

type ProviderSettingsTextFieldKey =
  | "apiBaseUrl"
  | "apiEndpoint"
  | "acpFlag"
  | "binaryPath"
  | "googleCloudProject"
  | "shareDir";

type ProviderSettingsTextField = {
  key: ProviderSettingsTextFieldKey;
  label: string;
  placeholder: string;
  description?: ReactNode;
};

type ResolvedProviderSettingsTextField = ProviderSettingsTextField & {
  value: string;
};

const PROVIDER_SETTINGS_BY_PROVIDER = {
  shiori: {
    provider: "shiori",
    title: "Shiori",
    textFields: [
      {
        key: "apiBaseUrl",
        label: "Shiori API base URL",
        placeholder: "https://shiori.ai",
        description: "Hosted Shiori API endpoint.",
      },
    ],
  },
  kimiCode: {
    provider: "kimiCode",
    title: "Kimi Code",
    textFields: [
      {
        key: "binaryPath",
        label: "Kimi binary path",
        placeholder: "kimi",
        description: "Path to the Kimi Code binary.",
      },
      {
        key: "shareDir",
        label: "Kimi share directory",
        placeholder: "Kimi share directory",
        description: "Optional directory for Kimi Code shared runtime files.",
      },
    ],
  },
  gemini: {
    provider: "gemini",
    title: "Gemini",
    textFields: [
      {
        key: "binaryPath",
        label: "Gemini binary path",
        placeholder: "gemini",
        description: "Path to the Gemini CLI binary.",
      },
      {
        key: "googleCloudProject",
        label: "Google Cloud project",
        placeholder: "GOOGLE_CLOUD_PROJECT",
        description: "Optional project ID passed to the Gemini ACP runtime.",
      },
      {
        key: "acpFlag",
        label: "ACP flag",
        placeholder: "--acp",
        description: "Optional Gemini ACP flag override.",
      },
    ],
  },
  cursor: {
    provider: "cursor",
    title: "Cursor",
    textFields: [
      {
        key: "binaryPath",
        label: "Cursor agent binary path",
        placeholder: "agent",
        description: "Path to the Cursor agent binary.",
      },
      {
        key: "apiEndpoint",
        label: "API endpoint",
        placeholder: "Cursor API endpoint",
        description: "Optional endpoint passed to `agent -e`.",
      },
    ],
  },
  codex: {
    provider: "codex",
    title: "Codex",
    textFields: [
      {
        key: "binaryPath",
        label: "Codex binary path",
        placeholder: "codex",
        description: "Path to the Codex binary.",
      },
    ],
    homePathKey: "codexHomePath",
    homePlaceholder: "CODEX_HOME",
    homeDescription: "Optional custom Codex home and config directory.",
  },
  claudeAgent: {
    provider: "claudeAgent",
    title: "Claude",
    textFields: [
      {
        key: "binaryPath",
        label: "Claude binary path",
        placeholder: "claude",
        description: "Path to the Claude binary.",
      },
    ],
  },
} as const satisfies Record<ProviderKind, InstallProviderSettings>;

const PROVIDER_SETTINGS: readonly InstallProviderSettings[] = Object.values(
  PROVIDER_SETTINGS_BY_PROVIDER,
);

const PROVIDER_STATUS_STYLES = {
  disabled: {
    dot: "bg-amber-400",
  },
  error: {
    dot: "bg-destructive",
  },
  ready: {
    dot: "bg-success",
  },
  warning: {
    dot: "bg-warning",
  },
} as const;

function getProviderSummary(provider: ServerProvider | undefined, enabled: boolean) {
  if (!provider && !enabled) {
    return {
      headline: "Disabled",
      detail: "This provider is disabled in ShioriCode settings.",
    };
  }
  if (!provider) {
    return {
      headline: "Checking provider status",
      detail: "Waiting for the server to report installation and authentication details.",
    };
  }
  if (!provider.enabled) {
    return {
      headline: "Disabled",
      detail:
        provider.message ??
        "This provider is installed but disabled for new sessions in ShioriCode.",
    };
  }
  if (!provider.installed) {
    return {
      headline: "Not found",
      detail: provider.message ?? "CLI not detected on PATH.",
    };
  }
  if (provider.auth.status === "authenticated") {
    const authLabel = provider.auth.label ?? provider.auth.type;
    return {
      headline: authLabel ? `Authenticated · ${authLabel}` : "Authenticated",
      detail: provider.message ?? null,
    };
  }
  if (provider.auth.status === "unauthenticated") {
    return {
      headline: "Not authenticated",
      detail: provider.message ?? null,
    };
  }
  if (provider.status === "warning") {
    return {
      headline: "Needs attention",
      detail:
        provider.message ?? "The provider is installed, but the server could not fully verify it.",
    };
  }
  if (provider.status === "error") {
    return {
      headline: "Unavailable",
      detail: provider.message ?? "The provider failed its startup checks.",
    };
  }
  return {
    headline: "Available",
    detail: provider.message ?? "Installed and ready, but authentication could not be verified.",
  };
}

function getProviderVersionLabel(version: string | null | undefined) {
  if (!version) return null;
  return version.startsWith("v") ? version : `v${version}`;
}

function readProviderTextField(
  providers: UnifiedSettings["providers"],
  provider: ProviderKind,
  key: ProviderSettingsTextFieldKey,
): string | null {
  switch (provider) {
    case "shiori":
      return key === "apiBaseUrl" ? providers.shiori.apiBaseUrl : null;
    case "kimiCode":
      if (key === "binaryPath") return providers.kimiCode.binaryPath;
      return key === "shareDir" ? providers.kimiCode.shareDir : null;
    case "gemini":
      if (key === "binaryPath") return providers.gemini.binaryPath;
      if (key === "googleCloudProject") return providers.gemini.googleCloudProject;
      return key === "acpFlag" ? providers.gemini.acpFlag : null;
    case "cursor":
      if (key === "binaryPath") return providers.cursor.binaryPath;
      return key === "apiEndpoint" ? providers.cursor.apiEndpoint : null;
    case "codex":
      return key === "binaryPath" ? providers.codex.binaryPath : null;
    case "claudeAgent":
      return key === "binaryPath" ? providers.claudeAgent.binaryPath : null;
  }
}

function updateProviderTextField(
  providers: UnifiedSettings["providers"],
  provider: ProviderKind,
  key: ProviderSettingsTextFieldKey,
  value: string,
): UnifiedSettings["providers"] {
  switch (provider) {
    case "shiori":
      return key === "apiBaseUrl"
        ? { ...providers, shiori: { ...providers.shiori, apiBaseUrl: value } }
        : providers;
    case "kimiCode":
      if (key === "binaryPath") {
        return { ...providers, kimiCode: { ...providers.kimiCode, binaryPath: value } };
      }
      return key === "shareDir"
        ? { ...providers, kimiCode: { ...providers.kimiCode, shareDir: value } }
        : providers;
    case "gemini":
      if (key === "binaryPath") {
        return { ...providers, gemini: { ...providers.gemini, binaryPath: value } };
      }
      if (key === "googleCloudProject") {
        return { ...providers, gemini: { ...providers.gemini, googleCloudProject: value } };
      }
      return key === "acpFlag"
        ? { ...providers, gemini: { ...providers.gemini, acpFlag: value } }
        : providers;
    case "cursor":
      if (key === "binaryPath") {
        return { ...providers, cursor: { ...providers.cursor, binaryPath: value } };
      }
      return key === "apiEndpoint"
        ? { ...providers, cursor: { ...providers.cursor, apiEndpoint: value } }
        : providers;
    case "codex":
      return key === "binaryPath"
        ? { ...providers, codex: { ...providers.codex, binaryPath: value } }
        : providers;
    case "claudeAgent":
      return key === "binaryPath"
        ? { ...providers, claudeAgent: { ...providers.claudeAgent, binaryPath: value } }
        : providers;
  }
}

function resolveProviderTextFields(
  providers: UnifiedSettings["providers"],
  provider: ProviderKind,
  fields: readonly ProviderSettingsTextField[] | undefined,
): ResolvedProviderSettingsTextField[] {
  const resolvedFields: ResolvedProviderSettingsTextField[] = [];

  for (const field of fields ?? []) {
    const value = readProviderTextField(providers, provider, field.key);
    if (value === null) {
      continue;
    }
    resolvedFields.push({
      key: field.key,
      label: field.label,
      placeholder: field.placeholder,
      description: field.description,
      value,
    });
  }

  return resolvedFields;
}

function useRelativeTimeTick(intervalMs = 1_000) {
  const [tick, setTick] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setTick(Date.now()), intervalMs);
    return () => clearInterval(id);
  }, [intervalMs]);
  return tick;
}

function ProviderLastChecked({ lastCheckedAt }: { lastCheckedAt: string | null }) {
  useRelativeTimeTick();
  const lastCheckedRelative = lastCheckedAt ? formatRelativeTime(lastCheckedAt) : null;

  if (!lastCheckedRelative) {
    return null;
  }

  return (
    <span className="text-[11px] text-muted-foreground/60">
      {lastCheckedRelative.suffix ? (
        <>
          Checked <span className="font-mono tabular-nums">{lastCheckedRelative.value}</span>{" "}
          {lastCheckedRelative.suffix}
        </>
      ) : (
        <>Checked {lastCheckedRelative.value}</>
      )}
    </span>
  );
}

export function SettingsSection({
  title,
  icon,
  headerAction,
  children,
}: {
  title: string;
  icon?: ReactNode;
  headerAction?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section className="space-y-2.5">
      <div className="flex min-h-7 items-center justify-between gap-3">
        <h2 className="flex min-w-0 items-center gap-1.5 text-[11px] font-medium text-muted-foreground">
          {icon}
          <span className="truncate">{title}</span>
        </h2>
        {headerAction ? <div className="shrink-0">{headerAction}</div> : null}
      </div>
      <div className="relative overflow-hidden rounded-lg border bg-card text-card-foreground shadow-xs/5 not-dark:bg-clip-padding before:pointer-events-none before:absolute before:inset-0 before:rounded-[calc(var(--radius-lg)-1px)] before:shadow-[0_1px_--theme(--color-black/4%)] dark:before:shadow-[0_-1px_--theme(--color-white/6%)]">
        {children}
      </div>
    </section>
  );
}

export function SettingsRow({
  title,
  description,
  status,
  resetAction,
  control,
  children,
}: {
  title: ReactNode;
  description: string;
  status?: ReactNode;
  resetAction?: ReactNode;
  control?: ReactNode;
  children?: ReactNode;
}) {
  return (
    <div className="min-h-[4.75rem] border-t border-border px-4 py-3.5 first:border-t-0 sm:px-5">
      <div className="grid min-w-0 gap-3 sm:grid-cols-[minmax(0,1fr)_minmax(12rem,auto)] sm:items-center">
        <div className="min-w-0 space-y-1">
          <div className="flex min-h-5 items-center gap-1.5">
            <h3 className="min-w-0 text-sm font-medium text-foreground">{title}</h3>
            <span className="inline-flex h-5 w-5 shrink-0 items-center justify-center">
              {resetAction}
            </span>
          </div>
          <p className="max-w-[42rem] text-xs leading-5 text-muted-foreground">{description}</p>
          {status ? <div className="pt-1 text-[11px] text-muted-foreground">{status}</div> : null}
        </div>
        {control ? (
          <div className="flex w-full min-w-0 shrink-0 items-center gap-2 sm:min-w-48 sm:justify-end">
            {control}
          </div>
        ) : null}
      </div>
      {children ? <div className="mt-3 min-w-0">{children}</div> : null}
    </div>
  );
}

function SettingResetButton({ label, onClick }: { label: string; onClick: () => void }) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            size="icon-xs"
            variant="ghost"
            aria-label={`Reset ${label} to default`}
            className="size-5 rounded-sm p-0 text-muted-foreground hover:text-foreground"
            onClick={(event) => {
              event.stopPropagation();
              onClick();
            }}
          >
            <Undo2Icon className="size-3" />
          </Button>
        }
      />
      <TooltipPopup side="top">Reset to default</TooltipPopup>
    </Tooltip>
  );
}

export function SettingsPageContainer({ children }: { children: ReactNode }) {
  return (
    <div className="min-h-0 flex-1 overflow-y-auto [scrollbar-gutter:stable]">
      <div className="mx-auto flex w-full max-w-[56rem] flex-col gap-5 px-4 py-5 sm:px-6 sm:py-6">
        {children}
      </div>
    </div>
  );
}

function AboutVersionTitle() {
  return (
    <span className="inline-flex items-center gap-2">
      <span>Version</span>
      <code className="text-[11px] font-medium text-muted-foreground">{APP_VERSION}</code>
    </span>
  );
}

function AboutVersionSection() {
  const queryClient = useQueryClient();
  const updateStateQuery = useDesktopUpdateState();

  const updateState = updateStateQuery.data ?? null;

  const handleButtonClick = useCallback(() => {
    const bridge = window.desktopBridge;
    if (!bridge) return;

    const action = updateState ? resolveDesktopUpdateButtonAction(updateState) : "none";

    if (action === "download") {
      void bridge
        .downloadUpdate()
        .then((result) => {
          setDesktopUpdateStateQueryData(queryClient, result.state);
        })
        .catch((error: unknown) => {
          toastManager.add({
            type: "error",
            title: "Could not download update",
            description: error instanceof Error ? error.message : "Download failed.",
          });
        });
      return;
    }

    if (action === "install") {
      const confirmed = window.confirm(
        getDesktopUpdateInstallConfirmationMessage(
          updateState ?? { availableVersion: null, downloadedVersion: null },
        ),
      );
      if (!confirmed) return;
      void bridge
        .installUpdate()
        .then((result) => {
          setDesktopUpdateStateQueryData(queryClient, result.state);
        })
        .catch((error: unknown) => {
          toastManager.add({
            type: "error",
            title: "Could not install update",
            description: error instanceof Error ? error.message : "Install failed.",
          });
        });
      return;
    }

    if (typeof bridge.checkForUpdate !== "function") return;
    void bridge
      .checkForUpdate()
      .then((result) => {
        setDesktopUpdateStateQueryData(queryClient, result.state);
        if (!result.checked) {
          toastManager.add({
            type: "error",
            title: "Could not check for updates",
            description:
              result.state.message ?? "Automatic updates are not available in this build.",
          });
        }
      })
      .catch((error: unknown) => {
        toastManager.add({
          type: "error",
          title: "Could not check for updates",
          description: error instanceof Error ? error.message : "Update check failed.",
        });
      });
  }, [queryClient, updateState]);

  const action = updateState ? resolveDesktopUpdateButtonAction(updateState) : "none";
  const buttonTooltip = updateState ? getDesktopUpdateButtonTooltip(updateState) : null;
  const buttonDisabled =
    action === "none"
      ? !canCheckForUpdate(updateState)
      : isDesktopUpdateButtonDisabled(updateState);

  const actionLabel: Record<string, string> = { download: "Download", install: "Install" };
  const statusLabel: Record<string, string> = {
    checking: "Checking…",
    downloading: "Downloading…",
    "up-to-date": "Up to Date",
  };
  const buttonLabel =
    actionLabel[action] ?? statusLabel[updateState?.status ?? ""] ?? "Check for Updates";
  const description =
    action === "download" || action === "install"
      ? "Update available."
      : "Current version of the application.";

  return (
    <SettingsRow
      title={<AboutVersionTitle />}
      description={description}
      control={
        <Tooltip>
          <TooltipTrigger
            render={
              <Button
                size="xs"
                variant={action === "install" ? "default" : "outline"}
                disabled={buttonDisabled}
                onClick={handleButtonClick}
              >
                {buttonLabel}
              </Button>
            }
          />
          {buttonTooltip ? <TooltipPopup>{buttonTooltip}</TooltipPopup> : null}
        </Tooltip>
      }
    />
  );
}

const COMPANION_CLI_MANUAL_COMMAND = "npm install --global shiori-cli";

function CompanionCliSection() {
  const [state, setState] = useState<DesktopCompanionCliState | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const canUseDesktopInstall = isElectron && window.desktopBridge !== undefined;

  useEffect(() => {
    if (!canUseDesktopInstall || !window.desktopBridge) {
      return;
    }

    let cancelled = false;
    setIsLoading(true);
    void window.desktopBridge
      .getCompanionCliState()
      .then((nextState) => {
        if (!cancelled) {
          setState(nextState);
        }
      })
      .catch((error: unknown) => {
        if (!cancelled) {
          setState({
            status: "error",
            version: null,
            binaryPath: null,
            lastError: error instanceof Error ? error.message : "Failed to read CLI status.",
            installCommand: COMPANION_CLI_MANUAL_COMMAND,
          });
        }
      })
      .finally(() => {
        if (!cancelled) {
          setIsLoading(false);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [canUseDesktopInstall]);

  const handleInstall = useCallback(() => {
    if (!window.desktopBridge || isLoading) {
      return;
    }
    setIsLoading(true);
    void window.desktopBridge
      .installCompanionCli()
      .then((result) => {
        setState(result.state);
        if (!result.completed) {
          toastManager.add({
            type: "error",
            title: "Could not install Shiori CLI",
            description: result.state.lastError ?? "Install failed.",
          });
        }
      })
      .catch((error: unknown) => {
        const description = error instanceof Error ? error.message : "Install failed.";
        setState((current) => ({
          status: "error",
          version: current?.version ?? null,
          binaryPath: current?.binaryPath ?? null,
          lastError: description,
          installCommand: current?.installCommand ?? COMPANION_CLI_MANUAL_COMMAND,
        }));
        toastManager.add({
          type: "error",
          title: "Could not install Shiori CLI",
          description,
        });
      })
      .finally(() => {
        setIsLoading(false);
      });
  }, [isLoading]);

  const installCommand = state?.installCommand ?? COMPANION_CLI_MANUAL_COMMAND;
  const status = state?.status ?? "not-installed";
  const buttonLabel =
    status === "installing" ? "Installing..." : status === "installed" ? "Reinstall" : "Install";

  return (
    <SettingsRow
      title="Shiori CLI"
      description="Install the companion `shiori` CLI for thread, session, and project commands."
      status={
        <div className="space-y-1">
          {canUseDesktopInstall ? (
            <>
              <span className="block">
                {status === "installed"
                  ? `Installed${state?.version ? ` · v${state.version}` : ""}`
                  : status === "installing"
                    ? "Installing companion CLI…"
                    : "Not installed"}
              </span>
              {state?.binaryPath ? (
                <code className="block break-all text-[11px] text-foreground">
                  {state.binaryPath}
                </code>
              ) : null}
              {state?.lastError ? (
                <span className="block text-destructive">{state.lastError}</span>
              ) : null}
              <code className="block break-all text-[11px] text-muted-foreground">
                {installCommand}
              </code>
            </>
          ) : (
            <>
              <span className="block">Desktop install is unavailable in the browser build.</span>
              <code className="block break-all text-[11px] text-foreground">
                {COMPANION_CLI_MANUAL_COMMAND}
              </code>
            </>
          )}
        </div>
      }
      control={
        isElectron ? (
          <Button size="xs" variant="outline" disabled={isLoading} onClick={handleInstall}>
            {buttonLabel}
          </Button>
        ) : null
      }
    />
  );
}

export function useSettingsRestore(onRestored?: () => void) {
  const settings = useSettings();
  const { resetSettings } = useUpdateSettings();

  const isGitWritingModelDirty = !Equal.equals(
    settings.textGenerationModelSelection ?? null,
    DEFAULT_UNIFIED_SETTINGS.textGenerationModelSelection ?? null,
  );
  const isDefaultModelDirty = !Equal.equals(
    settings.defaultModelSelection ?? null,
    DEFAULT_UNIFIED_SETTINGS.defaultModelSelection ?? null,
  );
  const areProviderSettingsDirty = PROVIDER_SETTINGS.some((providerSettings) => {
    const currentSettings = settings.providers[providerSettings.provider];
    const defaultSettings = DEFAULT_UNIFIED_SETTINGS.providers[providerSettings.provider];
    return !Equal.equals(currentSettings, defaultSettings);
  });

  const changedSettingLabels = useMemo(
    () => [
      ...(settings.themeMode !== DEFAULT_UNIFIED_SETTINGS.themeMode ? ["Theme mode"] : []),
      ...(settings.lightThemeId !== DEFAULT_UNIFIED_SETTINGS.lightThemeId ? ["Light theme"] : []),
      ...(settings.darkThemeId !== DEFAULT_UNIFIED_SETTINGS.darkThemeId ? ["Dark theme"] : []),
      ...(settings.blurPersonalData !== DEFAULT_UNIFIED_SETTINGS.blurPersonalData
        ? ["Hide personal details"]
        : []),
      ...(settings.composerVimMode !== DEFAULT_UNIFIED_SETTINGS.composerVimMode
        ? ["Composer Vim mode"]
        : []),
      ...(settings.uiFontFamily !== DEFAULT_UNIFIED_SETTINGS.uiFontFamily ? ["UI font"] : []),
      ...(settings.codeFontFamily !== DEFAULT_UNIFIED_SETTINGS.codeFontFamily ? ["Code font"] : []),
      ...(settings.importedThemes.length > 0 ? ["Imported themes"] : []),
      ...(settings.timestampFormat !== DEFAULT_UNIFIED_SETTINGS.timestampFormat
        ? ["Time format"]
        : []),
      ...(settings.diffWordWrap !== DEFAULT_UNIFIED_SETTINGS.diffWordWrap
        ? ["Diff line wrapping"]
        : []),
      ...(settings.enableAssistantStreaming !== DEFAULT_UNIFIED_SETTINGS.enableAssistantStreaming
        ? ["Assistant output"]
        : []),
      ...(settings.generateMemories !== DEFAULT_UNIFIED_SETTINGS.generateMemories
        ? ["Memories"]
        : []),
      ...(settings.kanban.enabled &&
      settings.autoGenerateKanbanTaskPrompts !==
        DEFAULT_UNIFIED_SETTINGS.autoGenerateKanbanTaskPrompts
        ? ["Goal planning"]
        : []),
      ...(settings.assistantPersonality !== DEFAULT_ASSISTANT_PERSONALITY
        ? ["Assistant personality"]
        : []),
      ...(settings.defaultThreadEnvMode !== DEFAULT_UNIFIED_SETTINGS.defaultThreadEnvMode
        ? ["New Thread mode"]
        : []),
      ...(isDefaultModelDirty ? ["Default model"] : []),
      ...(settings.confirmThreadDelete !== DEFAULT_UNIFIED_SETTINGS.confirmThreadDelete
        ? ["Delete confirmation"]
        : []),
      ...(settings.quitWithoutConfirmation !== DEFAULT_UNIFIED_SETTINGS.quitWithoutConfirmation
        ? ["Quit confirmation"]
        : []),
      ...(!Equal.equals(settings.onboarding, DEFAULT_UNIFIED_SETTINGS.onboarding)
        ? ["Onboarding"]
        : []),
      ...(isGitWritingModelDirty ? ["Git writing model"] : []),
      ...(areProviderSettingsDirty ? ["Providers"] : []),
    ],
    [
      areProviderSettingsDirty,
      settings.blurPersonalData,
      settings.codeFontFamily,
      settings.composerVimMode,
      isDefaultModelDirty,
      isGitWritingModelDirty,
      settings.confirmThreadDelete,
      settings.darkThemeId,
      settings.defaultThreadEnvMode,
      settings.diffWordWrap,
      settings.enableAssistantStreaming,
      settings.kanban.enabled,
      settings.autoGenerateKanbanTaskPrompts,
      settings.generateMemories,
      settings.importedThemes.length,
      settings.lightThemeId,
      settings.onboarding,
      settings.quitWithoutConfirmation,
      settings.uiFontFamily,
      settings.assistantPersonality,
      settings.themeMode,
      settings.timestampFormat,
    ],
  );

  const restoreDefaults = useCallback(async () => {
    if (changedSettingLabels.length === 0) return;
    const api = readNativeApi();
    const confirmed = await (api ?? ensureNativeApi()).dialogs.confirm(
      ["Restore default settings?", `This will reset: ${changedSettingLabels.join(", ")}.`].join(
        "\n",
      ),
    );
    if (!confirmed) return;

    resetSettings();
    onRestored?.();
  }, [changedSettingLabels, onRestored, resetSettings]);

  return {
    changedSettingLabels,
    restoreDefaults,
  };
}

export function GeneralSettingsPanel() {
  const settings = useSettings();
  const { updateSettings } = useUpdateSettings();
  const { viewer, catalogProviders } = useHostedShioriState();
  const canTriggerOnboarding = import.meta.env.DEV && Boolean(viewer?.isAdmin);
  const onboardingState = useMemo(
    () => resolveOnboardingState(settings.onboarding),
    [settings.onboarding],
  );
  const [pendingOnboardingStepId, setPendingOnboardingStepId] = useState<OnboardingStepId | null>(
    null,
  );
  const [isResettingOnboarding, setIsResettingOnboarding] = useState(false);
  const [isOpeningKeybindings, setIsOpeningKeybindings] = useState(false);
  const [openKeybindingsError, setOpenKeybindingsError] = useState<string | null>(null);
  const [openProviderDetails, setOpenProviderDetails] = useState<Record<ProviderKind, boolean>>({
    shiori: Boolean(
      settings.providers.shiori.apiBaseUrl !==
        DEFAULT_UNIFIED_SETTINGS.providers.shiori.apiBaseUrl ||
      settings.providers.shiori.customModels.length > 0,
    ),
    kimiCode: Boolean(
      settings.providers.kimiCode.binaryPath !==
        DEFAULT_UNIFIED_SETTINGS.providers.kimiCode.binaryPath ||
      settings.providers.kimiCode.shareDir !==
        DEFAULT_UNIFIED_SETTINGS.providers.kimiCode.shareDir ||
      settings.providers.kimiCode.customModels.length > 0,
    ),
    gemini: Boolean(
      settings.providers.gemini.binaryPath !==
        DEFAULT_UNIFIED_SETTINGS.providers.gemini.binaryPath ||
      settings.providers.gemini.googleCloudProject !==
        DEFAULT_UNIFIED_SETTINGS.providers.gemini.googleCloudProject ||
      settings.providers.gemini.acpFlag !== DEFAULT_UNIFIED_SETTINGS.providers.gemini.acpFlag ||
      settings.providers.gemini.customModels.length > 0,
    ),
    cursor: Boolean(
      settings.providers.cursor.binaryPath !==
        DEFAULT_UNIFIED_SETTINGS.providers.cursor.binaryPath ||
      settings.providers.cursor.apiEndpoint !==
        DEFAULT_UNIFIED_SETTINGS.providers.cursor.apiEndpoint ||
      settings.providers.cursor.customModels.length > 0,
    ),
    codex: Boolean(
      settings.providers.codex.binaryPath !== DEFAULT_UNIFIED_SETTINGS.providers.codex.binaryPath ||
      settings.providers.codex.homePath !== DEFAULT_UNIFIED_SETTINGS.providers.codex.homePath ||
      settings.providers.codex.customModels.length > 0,
    ),
    claudeAgent: Boolean(
      settings.providers.claudeAgent.binaryPath !==
        DEFAULT_UNIFIED_SETTINGS.providers.claudeAgent.binaryPath ||
      settings.providers.claudeAgent.customModels.length > 0,
    ),
  });
  const [isRefreshingProviders, setIsRefreshingProviders] = useState(false);
  const refreshingRef = useRef(false);
  const modelListRefs = useRef<Partial<Record<ProviderKind, HTMLDivElement | null>>>({});
  const refreshProviders = useCallback(() => {
    if (refreshingRef.current) return;
    refreshingRef.current = true;
    setIsRefreshingProviders(true);
    void ensureNativeApi()
      .server.refreshProviders()
      .catch((error: unknown) => {
        console.warn("Failed to refresh providers", error);
      })
      .finally(() => {
        refreshingRef.current = false;
        setIsRefreshingProviders(false);
      });
  }, []);

  const completeOnboardingStep = useCallback((stepId: OnboardingStepId) => {
    setPendingOnboardingStepId(stepId);
    void ensureNativeApi()
      .onboarding.completeStep({ stepId })
      .catch((error: unknown) => {
        toastManager.add({
          type: "error",
          title: "Could not complete onboarding step",
          description:
            error instanceof Error ? error.message : "The onboarding step could not be completed.",
        });
      })
      .finally(() => {
        setPendingOnboardingStepId((currentStepId) =>
          currentStepId === stepId ? null : currentStepId,
        );
      });
  }, []);

  const resetOnboarding = useCallback(() => {
    setIsResettingOnboarding(true);
    void ensureNativeApi()
      .onboarding.reset()
      .catch((error: unknown) => {
        toastManager.add({
          type: "error",
          title: "Could not reset onboarding",
          description:
            error instanceof Error ? error.message : "The onboarding progress could not be reset.",
        });
      })
      .finally(() => {
        setIsResettingOnboarding(false);
      });
  }, []);

  const keybindingsConfigPath = useServerKeybindingsConfigPath();
  const availableEditors = useServerAvailableEditors();
  const baseServerProviders = useServerProviders();
  const serverProviders = useMergedServerProviders(baseServerProviders);
  const codexHomePath = settings.providers.codex.homePath;

  const defaultModelSelection = resolveConfigurableModelSelectionState(
    settings.defaultModelSelection,
    settings,
    serverProviders,
  );
  const defaultModelProvider = defaultModelSelection.provider;
  const defaultModel = defaultModelSelection.model;
  const defaultModelOptions = defaultModelSelection.options;
  const defaultModelOptionsByProvider = getCustomModelOptionsByProvider(
    settings,
    serverProviders,
    defaultModelProvider,
    defaultModel,
  );
  const isDefaultModelDirty = !Equal.equals(
    settings.defaultModelSelection ?? null,
    DEFAULT_UNIFIED_SETTINGS.defaultModelSelection ?? null,
  );

  const textGenerationModelSelection = resolveAppModelSelectionState(settings, serverProviders);
  const textGenProvider = textGenerationModelSelection.provider;
  const textGenModel = textGenerationModelSelection.model;
  const textGenModelOptions = textGenerationModelSelection.options;
  const assistantPersonalityOption =
    ASSISTANT_PERSONALITY_OPTIONS.find(
      (option) => option.value === settings.assistantPersonality,
    ) ?? ASSISTANT_PERSONALITY_OPTIONS[0]!;
  const gitModelOptionsByProvider = getCustomModelOptionsByProvider(
    settings,
    serverProviders,
    textGenProvider,
    textGenModel,
  );
  const isGitWritingModelDirty = !Equal.equals(
    settings.textGenerationModelSelection ?? null,
    DEFAULT_UNIFIED_SETTINGS.textGenerationModelSelection ?? null,
  );
  const openKeybindingsFile = useCallback(() => {
    if (!keybindingsConfigPath) return;
    setOpenKeybindingsError(null);
    setIsOpeningKeybindings(true);
    const editor = resolveAndPersistPreferredEditor(availableEditors ?? []);
    if (!editor) {
      setOpenKeybindingsError("No available editors found.");
      setIsOpeningKeybindings(false);
      return;
    }
    void ensureNativeApi()
      .shell.openInEditor(keybindingsConfigPath, editor)
      .catch((error) => {
        setOpenKeybindingsError(
          error instanceof Error ? error.message : "Unable to open keybindings file.",
        );
      })
      .finally(() => {
        setIsOpeningKeybindings(false);
      });
  }, [availableEditors, keybindingsConfigPath]);

  const removeCustomModel = useCallback(
    (provider: ProviderKind, slug: string) => {
      updateSettings({
        providers: {
          ...settings.providers,
          [provider]: {
            ...settings.providers[provider],
            customModels: settings.providers[provider].customModels.filter(
              (model) => model !== slug,
            ),
          },
        },
      });
    },
    [settings, updateSettings],
  );

  const providerCards = PROVIDER_SETTINGS.map((providerSettings) => {
    const liveProvider = serverProviders.find(
      (candidate) => candidate.provider === providerSettings.provider,
    );
    const providerConfig = settings.providers[providerSettings.provider];
    const defaultProviderConfig = DEFAULT_UNIFIED_SETTINGS.providers[providerSettings.provider];
    const statusKey = liveProvider?.status ?? (providerConfig.enabled ? "warning" : "disabled");
    const summary = getProviderSummary(liveProvider, providerConfig.enabled);
    const fallbackModels = providerConfig.customModels.map((slug) => ({
      slug,
      name: slug,
      isCustom: true,
      capabilities: null,
    }));
    const models: ReadonlyArray<ServerProviderModel> =
      providerSettings.provider === "shiori" && catalogProviders !== undefined
        ? flattenHostedShioriSettingsModels(catalogProviders)
        : (liveProvider?.models ?? fallbackModels);

    return {
      provider: providerSettings.provider,
      title: providerSettings.title,
      textFields: resolveProviderTextFields(
        settings.providers,
        providerSettings.provider,
        providerSettings.textFields,
      ),
      homePathKey: providerSettings.homePathKey,
      homePlaceholder: providerSettings.homePlaceholder,
      homeDescription: providerSettings.homeDescription,
      isDirty: !Equal.equals(providerConfig, defaultProviderConfig),
      liveProvider,
      models,
      providerConfig,
      statusStyle: PROVIDER_STATUS_STYLES[statusKey],
      summary,
      versionLabel: getProviderVersionLabel(liveProvider?.version),
    };
  });

  const lastCheckedAt =
    serverProviders.length > 0
      ? serverProviders.reduce(
          (latest, provider) => (provider.checkedAt > latest ? provider.checkedAt : latest),
          serverProviders[0]!.checkedAt,
        )
      : null;
  return (
    <SettingsPageContainer>
      <SettingsSection
        title="Onboarding"
        headerAction={
          canTriggerOnboarding ? (
            <Button
              size="xs"
              variant="outline"
              disabled={isResettingOnboarding}
              onClick={resetOnboarding}
            >
              {isResettingOnboarding ? "Triggering..." : "Trigger onboarding"}
            </Button>
          ) : undefined
        }
      >
        <SettingsRow
          title="Flow status"
          description="Track first-run setup and jump back into the guided welcome flow when you need it."
          status={
            onboardingState.completed
              ? "All steps completed."
              : `${onboardingState.completedCount}/${onboardingState.totalSteps} steps completed.`
          }
          control={
            <Button
              size="xs"
              variant="outline"
              disabled={isResettingOnboarding || onboardingState.completedCount === 0}
              onClick={resetOnboarding}
            >
              {isResettingOnboarding ? "Resetting..." : "Reset"}
            </Button>
          }
        />
        {onboardingState.steps.map((step) => {
          const locked =
            !step.completed &&
            onboardingState.currentStepId !== null &&
            onboardingState.currentStepId !== step.id;
          const pending = pendingOnboardingStepId === step.id;

          return (
            <SettingsRow
              key={step.id}
              title={step.title}
              description={step.description}
              status={
                step.completed
                  ? "Completed"
                  : locked
                    ? "Locked until previous steps are completed."
                    : "Current step"
              }
              control={
                <Button
                  size="xs"
                  variant="outline"
                  disabled={step.completed || locked || pending}
                  onClick={() => completeOnboardingStep(step.id)}
                >
                  {step.completed ? "Done" : pending ? "Saving..." : "Complete step"}
                </Button>
              }
            />
          );
        })}
      </SettingsSection>

      <SettingsSection title="General">
        <SettingsRow
          title="Composer Vim mode"
          description="Use a lightweight Vim editing mode in the message composer."
          resetAction={
            settings.composerVimMode !== DEFAULT_UNIFIED_SETTINGS.composerVimMode ? (
              <SettingResetButton
                label="Composer Vim mode"
                onClick={() =>
                  updateSettings({
                    composerVimMode: DEFAULT_UNIFIED_SETTINGS.composerVimMode,
                  })
                }
              />
            ) : null
          }
          control={
            <Switch
              checked={settings.composerVimMode}
              onCheckedChange={(checked) => updateSettings({ composerVimMode: Boolean(checked) })}
              aria-label="Enable composer Vim mode"
            />
          }
        />

        <SettingsRow
          title="Assistant output"
          description="Show token-by-token output while a response is in progress."
          resetAction={
            settings.enableAssistantStreaming !==
            DEFAULT_UNIFIED_SETTINGS.enableAssistantStreaming ? (
              <SettingResetButton
                label="assistant output"
                onClick={() =>
                  updateSettings({
                    enableAssistantStreaming: DEFAULT_UNIFIED_SETTINGS.enableAssistantStreaming,
                  })
                }
              />
            ) : null
          }
          control={
            <Switch
              checked={settings.enableAssistantStreaming}
              onCheckedChange={(checked) =>
                updateSettings({ enableAssistantStreaming: Boolean(checked) })
              }
              aria-label="Stream assistant messages"
            />
          }
        />

        <SettingsRow
          title="Memories"
          description="Ask supported runtimes to generate and refresh durable memories for future turns."
          resetAction={
            settings.generateMemories !== DEFAULT_UNIFIED_SETTINGS.generateMemories ? (
              <SettingResetButton
                label="memories"
                onClick={() =>
                  updateSettings({
                    generateMemories: DEFAULT_UNIFIED_SETTINGS.generateMemories,
                  })
                }
              />
            ) : null
          }
          control={
            <Switch
              checked={settings.generateMemories}
              onCheckedChange={(checked) => updateSettings({ generateMemories: Boolean(checked) })}
              aria-label="Generate memories"
            />
          }
        >
          <p className="mt-3 text-xs text-muted-foreground">
            When enabled, ShioriCode adds a memory-generation overlay to provider prompts for
            runtimes that support persistent memories.
          </p>
        </SettingsRow>

        {settings.kanban.enabled ? (
          <SettingsRow
            title="Goal planning"
            description="Generate a concise editable plan in the background when a goal is created."
            resetAction={
              settings.autoGenerateKanbanTaskPrompts !==
              DEFAULT_UNIFIED_SETTINGS.autoGenerateKanbanTaskPrompts ? (
                <SettingResetButton
                  label="Goal planning"
                  onClick={() =>
                    updateSettings({
                      autoGenerateKanbanTaskPrompts:
                        DEFAULT_UNIFIED_SETTINGS.autoGenerateKanbanTaskPrompts,
                    })
                  }
                />
              ) : null
            }
            control={
              <Switch
                checked={settings.autoGenerateKanbanTaskPrompts}
                onCheckedChange={(checked) =>
                  updateSettings({ autoGenerateKanbanTaskPrompts: Boolean(checked) })
                }
                aria-label="Generate goal plans"
              />
            }
          />
        ) : null}

        <SettingsRow
          title="Assistant personality"
          description="Adds a tone appendix to ShioriCode, Codex, and Claude provider instructions."
          resetAction={
            settings.assistantPersonality !== DEFAULT_ASSISTANT_PERSONALITY ? (
              <SettingResetButton
                label="assistant personality"
                onClick={() =>
                  updateSettings({
                    assistantPersonality: DEFAULT_ASSISTANT_PERSONALITY,
                  })
                }
              />
            ) : null
          }
          control={
            <Select
              value={settings.assistantPersonality}
              onValueChange={(value) => {
                if (
                  value === "default" ||
                  value === "friendly" ||
                  value === "sassy" ||
                  value === "coach" ||
                  value === "pragmatic"
                ) {
                  updateSettings({ assistantPersonality: value });
                }
              }}
            >
              <SelectTrigger className="w-full sm:w-44" aria-label="Assistant personality">
                <SelectValue>{assistantPersonalityOption.label}</SelectValue>
              </SelectTrigger>
              <SelectPopup align="end" alignItemWithTrigger={false}>
                {ASSISTANT_PERSONALITY_OPTIONS.map((option) => (
                  <SelectItem hideIndicator key={option.value} value={option.value}>
                    {option.label}
                  </SelectItem>
                ))}
              </SelectPopup>
            </Select>
          }
        >
          <p className="mt-3 text-xs text-muted-foreground">
            {assistantPersonalityOption.description}
          </p>
        </SettingsRow>

        <SettingsRow
          title="New Threads"
          description="Pick the default workspace mode for newly created draft threads."
          resetAction={
            settings.defaultThreadEnvMode !== DEFAULT_UNIFIED_SETTINGS.defaultThreadEnvMode ? (
              <SettingResetButton
                label="new threads"
                onClick={() =>
                  updateSettings({
                    defaultThreadEnvMode: DEFAULT_UNIFIED_SETTINGS.defaultThreadEnvMode,
                  })
                }
              />
            ) : null
          }
          control={
            <Select
              value={settings.defaultThreadEnvMode}
              onValueChange={(value) => {
                if (value === "local" || value === "worktree") {
                  updateSettings({ defaultThreadEnvMode: value });
                }
              }}
            >
              <SelectTrigger className="w-full sm:w-44" aria-label="Default thread mode">
                <SelectValue>
                  {settings.defaultThreadEnvMode === "worktree" ? "New worktree" : "Local"}
                </SelectValue>
              </SelectTrigger>
              <SelectPopup align="end" alignItemWithTrigger={false}>
                <SelectItem hideIndicator value="local">
                  Local
                </SelectItem>
                <SelectItem hideIndicator value="worktree">
                  New worktree
                </SelectItem>
              </SelectPopup>
            </Select>
          }
        />

        <SettingsRow
          title="Quit without asking"
          description="Skip the desktop quit confirmation window."
          resetAction={
            settings.quitWithoutConfirmation !==
            DEFAULT_UNIFIED_SETTINGS.quitWithoutConfirmation ? (
              <SettingResetButton
                label="quit confirmation"
                onClick={() =>
                  updateSettings({
                    quitWithoutConfirmation: DEFAULT_UNIFIED_SETTINGS.quitWithoutConfirmation,
                  })
                }
              />
            ) : null
          }
          control={
            <label className="flex cursor-pointer items-center gap-2 text-sm text-foreground">
              <Checkbox
                checked={settings.quitWithoutConfirmation}
                onCheckedChange={(checked) =>
                  updateSettings({ quitWithoutConfirmation: Boolean(checked) })
                }
                aria-label="Quit without asking"
              />
              <span className="select-none">Quit without asking</span>
            </label>
          }
        />

        <SettingsRow
          title="Delete confirmation"
          description="Ask before deleting a thread and its chat history."
          resetAction={
            settings.confirmThreadDelete !== DEFAULT_UNIFIED_SETTINGS.confirmThreadDelete ? (
              <SettingResetButton
                label="delete confirmation"
                onClick={() =>
                  updateSettings({
                    confirmThreadDelete: DEFAULT_UNIFIED_SETTINGS.confirmThreadDelete,
                  })
                }
              />
            ) : null
          }
          control={
            <Switch
              checked={settings.confirmThreadDelete}
              onCheckedChange={(checked) =>
                updateSettings({ confirmThreadDelete: Boolean(checked) })
              }
              aria-label="Confirm thread deletion"
            />
          }
        />

        <CompanionCliSection />

        <SettingsRow
          title="Default model"
          description="Choose the model new projects use by default for their first thread."
          resetAction={
            isDefaultModelDirty ? (
              <SettingResetButton
                label="default model"
                onClick={() =>
                  updateSettings({
                    defaultModelSelection: DEFAULT_UNIFIED_SETTINGS.defaultModelSelection,
                  })
                }
              />
            ) : null
          }
          control={
            <div className="flex flex-wrap items-center justify-end gap-1.5">
              <ProviderModelPicker
                provider={defaultModelProvider}
                model={defaultModel}
                lockedProvider={null}
                providers={serverProviders}
                modelOptionsByProvider={defaultModelOptionsByProvider}
                modelOptions={defaultModelOptions}
                triggerVariant="outline"
                triggerClassName="min-w-0 max-w-none shrink-0 text-foreground/90 hover:text-foreground"
                onProviderModelChange={(provider, model) => {
                  updateSettings({
                    defaultModelSelection: resolveConfigurableModelSelectionState(
                      { provider, model },
                      settings,
                      serverProviders,
                    ),
                  });
                }}
              />
              <TraitsPicker
                provider={defaultModelProvider}
                models={
                  serverProviders.find((provider) => provider.provider === defaultModelProvider)
                    ?.models ?? []
                }
                model={defaultModel}
                prompt=""
                onPromptChange={() => {}}
                modelOptions={defaultModelOptions}
                allowPromptInjectedEffort={false}
                triggerVariant="outline"
                triggerClassName="min-w-0 max-w-none shrink-0 text-foreground/90 hover:text-foreground"
                onModelOptionsChange={(nextOptions) => {
                  updateSettings({
                    defaultModelSelection: resolveConfigurableModelSelectionState(
                      buildProviderModelSelection(defaultModelProvider, defaultModel, nextOptions),
                      settings,
                      serverProviders,
                    ),
                  });
                }}
              />
            </div>
          }
        />

        <SettingsRow
          title="Text generation model"
          description="Configure the model used for generated commit messages, PR titles, and similar Git text."
          resetAction={
            isGitWritingModelDirty ? (
              <SettingResetButton
                label="text generation model"
                onClick={() =>
                  updateSettings({
                    textGenerationModelSelection:
                      DEFAULT_UNIFIED_SETTINGS.textGenerationModelSelection,
                  })
                }
              />
            ) : null
          }
          control={
            <div className="flex flex-wrap items-center justify-end gap-1.5">
              <ProviderModelPicker
                provider={textGenProvider}
                model={textGenModel}
                lockedProvider={null}
                providers={serverProviders}
                modelOptionsByProvider={gitModelOptionsByProvider}
                modelOptions={settings.textGenerationModelSelection.options}
                triggerVariant="outline"
                triggerClassName="min-w-0 max-w-none shrink-0 text-foreground/90 hover:text-foreground"
                onProviderModelChange={(provider, model) => {
                  updateSettings({
                    textGenerationModelSelection: resolveAppModelSelectionState(
                      {
                        ...settings,
                        textGenerationModelSelection: { provider, model },
                      },
                      serverProviders,
                    ),
                  });
                }}
              />
              <TraitsPicker
                provider={textGenProvider}
                models={
                  serverProviders.find((provider) => provider.provider === textGenProvider)
                    ?.models ?? []
                }
                model={textGenModel}
                prompt=""
                onPromptChange={() => {}}
                modelOptions={textGenModelOptions}
                allowPromptInjectedEffort={false}
                triggerVariant="outline"
                triggerClassName="min-w-0 max-w-none shrink-0 text-foreground/90 hover:text-foreground"
                onModelOptionsChange={(nextOptions) => {
                  updateSettings({
                    textGenerationModelSelection: resolveAppModelSelectionState(
                      {
                        ...settings,
                        textGenerationModelSelection: buildProviderModelSelection(
                          textGenProvider,
                          textGenModel,
                          nextOptions,
                        ),
                      },
                      serverProviders,
                    ),
                  });
                }}
              />
            </div>
          }
        />
      </SettingsSection>

      <SettingsSection
        title="Providers"
        headerAction={
          <div className="flex items-center gap-1.5">
            <ProviderLastChecked lastCheckedAt={lastCheckedAt} />
            <Tooltip>
              <TooltipTrigger
                render={
                  <Button
                    size={isRefreshingProviders ? "xs" : "icon-xs"}
                    variant="ghost"
                    className={cn(
                      "rounded-sm text-muted-foreground hover:text-foreground",
                      isRefreshingProviders ? "px-2" : "size-5 p-0",
                    )}
                    disabled={isRefreshingProviders}
                    onClick={() => void refreshProviders()}
                    aria-label="Refresh provider status"
                  >
                    {isRefreshingProviders ? (
                      <LoadingText>Refreshing</LoadingText>
                    ) : (
                      <RefreshCwIcon className="size-3" />
                    )}
                  </Button>
                }
              />
              <TooltipPopup side="top">Refresh provider status</TooltipPopup>
            </Tooltip>
          </div>
        }
      >
        {providerCards.map((providerCard) => {
          const providerDisplayName =
            PROVIDER_DISPLAY_NAMES[providerCard.provider] ?? providerCard.title;

          return (
            <div key={providerCard.provider} className="border-t border-border first:border-t-0">
              <div className="px-4 py-4 sm:px-5">
                <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                  <div className="min-w-0 flex-1 space-y-1">
                    <div className="flex min-h-5 items-center gap-1.5">
                      <span
                        className={cn("size-2 shrink-0 rounded-full", providerCard.statusStyle.dot)}
                      />
                      <h3 className="text-sm font-medium text-foreground">{providerDisplayName}</h3>
                      {providerCard.versionLabel ? (
                        <code className="text-xs text-muted-foreground">
                          {providerCard.versionLabel}
                        </code>
                      ) : null}
                      <span className="inline-flex h-5 w-5 shrink-0 items-center justify-center">
                        {providerCard.isDirty ? (
                          <SettingResetButton
                            label={`${providerDisplayName} provider settings`}
                            onClick={() => {
                              updateSettings({
                                providers: {
                                  ...settings.providers,
                                  [providerCard.provider]:
                                    DEFAULT_UNIFIED_SETTINGS.providers[providerCard.provider],
                                },
                              });
                            }}
                          />
                        ) : null}
                      </span>
                    </div>
                    <p className="text-xs text-muted-foreground">
                      <span
                        className={getPersonalDetailsBlurClass(
                          shouldBlurEmailMention({
                            blurPersonalData: settings.blurPersonalData,
                            email: viewer?.email,
                            text: providerCard.summary.headline,
                          }),
                        )}
                      >
                        {providerCard.summary.headline}
                      </span>
                      {providerCard.summary.detail ? ` - ${providerCard.summary.detail}` : null}
                    </p>
                  </div>
                  <div className="flex w-full shrink-0 items-center gap-2 sm:w-auto sm:justify-end">
                    <Button
                      size="sm"
                      variant="ghost"
                      className="h-7 px-2 text-xs text-muted-foreground hover:text-foreground"
                      onClick={() =>
                        setOpenProviderDetails((existing) => ({
                          ...existing,
                          [providerCard.provider]: !existing[providerCard.provider],
                        }))
                      }
                      aria-label={`Toggle ${providerDisplayName} details`}
                    >
                      <ChevronDownIcon
                        className={cn(
                          "size-3.5 transition-transform",
                          openProviderDetails[providerCard.provider] && "rotate-180",
                        )}
                      />
                    </Button>
                    <Switch
                      checked={providerCard.providerConfig.enabled}
                      onCheckedChange={(checked) => {
                        const isDisabling = !checked;
                        const shouldClearModelSelection =
                          isDisabling && textGenProvider === providerCard.provider;
                        updateSettings({
                          providers: {
                            ...settings.providers,
                            [providerCard.provider]: {
                              ...settings.providers[providerCard.provider],
                              enabled: Boolean(checked),
                            },
                          },
                          ...(shouldClearModelSelection
                            ? {
                                textGenerationModelSelection:
                                  DEFAULT_UNIFIED_SETTINGS.textGenerationModelSelection,
                              }
                            : {}),
                        });
                      }}
                      aria-label={`Enable ${providerDisplayName}`}
                    />
                  </div>
                </div>
              </div>

              <Collapsible
                open={openProviderDetails[providerCard.provider]}
                onOpenChange={(open) =>
                  setOpenProviderDetails((existing) => ({
                    ...existing,
                    [providerCard.provider]: open,
                  }))
                }
              >
                <CollapsibleContent>
                  <div className="space-y-0">
                    {providerCard.provider === "shiori" ? (
                      <div className="border-t border-border/60 px-4 py-3 sm:px-5">
                        <HostedShioriAuthPanel
                          compact
                          disabled={!providerCard.providerConfig.enabled}
                          heading="Shiori account"
                          description="Use the same Shiori auth methods here as on the main sign-in screen."
                        />
                      </div>
                    ) : null}

                    {providerCard.textFields.map((field) => (
                      <div
                        key={`${providerCard.provider}:${field.key}`}
                        className="border-t border-border/60 px-4 py-3 sm:px-5"
                      >
                        <label
                          htmlFor={`provider-install-${providerCard.provider}-${field.key}`}
                          className="block"
                        >
                          <span className="text-xs font-medium text-foreground">{field.label}</span>
                          <Input
                            id={`provider-install-${providerCard.provider}-${field.key}`}
                            className="mt-1.5"
                            value={field.value}
                            onChange={(event) =>
                              updateSettings({
                                providers: updateProviderTextField(
                                  settings.providers,
                                  providerCard.provider,
                                  field.key,
                                  event.target.value,
                                ),
                              })
                            }
                            placeholder={field.placeholder}
                            spellCheck={false}
                          />
                          {field.description ? (
                            <span className="mt-1 block text-xs text-muted-foreground">
                              {field.description}
                            </span>
                          ) : null}
                        </label>
                      </div>
                    ))}

                    {providerCard.homePathKey ? (
                      <div className="border-t border-border/60 px-4 py-3 sm:px-5">
                        <label
                          htmlFor={`provider-install-${providerCard.homePathKey}`}
                          className="block"
                        >
                          <span className="text-xs font-medium text-foreground">
                            CODEX_HOME path
                          </span>
                          <Input
                            id={`provider-install-${providerCard.homePathKey}`}
                            className="mt-1.5"
                            value={codexHomePath}
                            onChange={(event) =>
                              updateSettings({
                                providers: {
                                  ...settings.providers,
                                  codex: {
                                    ...settings.providers.codex,
                                    homePath: event.target.value,
                                  },
                                },
                              })
                            }
                            placeholder={providerCard.homePlaceholder}
                            spellCheck={false}
                          />
                          {providerCard.homeDescription ? (
                            <span className="mt-1 block text-xs text-muted-foreground">
                              {providerCard.homeDescription}
                            </span>
                          ) : null}
                        </label>
                      </div>
                    ) : null}

                    <div className="border-t border-border/60 px-4 py-3 sm:px-5">
                      <div className="text-xs font-medium text-foreground">Models</div>
                      <div className="mt-1 text-xs text-muted-foreground">
                        {providerCard.models.length} model
                        {providerCard.models.length === 1 ? "" : "s"} available.
                      </div>
                      <div
                        ref={(el) => {
                          modelListRefs.current[providerCard.provider] = el;
                        }}
                        className="mt-2 max-h-40 overflow-y-auto pb-1"
                      >
                        {providerCard.models.map((model) => {
                          const caps = model.capabilities;
                          const capLabels: string[] = [];
                          if (caps?.supportsFastMode) capLabels.push("Fast mode");
                          if (caps?.supportsThinkingToggle) capLabels.push("Thinking");
                          if (
                            caps?.reasoningEffortLevels &&
                            caps.reasoningEffortLevels.length > 0
                          ) {
                            capLabels.push("Reasoning");
                          }
                          const hasDetails = capLabels.length > 0 || model.name !== model.slug;

                          return (
                            <div
                              key={`${providerCard.provider}:${model.slug}`}
                              className="flex items-center gap-2 py-1"
                            >
                              <span className="min-w-0 truncate text-xs text-foreground/90">
                                {model.name}
                              </span>
                              {hasDetails ? (
                                <Tooltip>
                                  <TooltipTrigger
                                    render={
                                      <button
                                        type="button"
                                        className="shrink-0 text-muted-foreground/40 transition-colors hover:text-muted-foreground"
                                        aria-label={`Details for ${model.name}`}
                                      />
                                    }
                                  >
                                    <InfoIcon className="size-3" />
                                  </TooltipTrigger>
                                  <TooltipPopup side="top" className="max-w-56">
                                    <div className="space-y-1">
                                      <code className="block text-[11px] text-foreground">
                                        {model.slug}
                                      </code>
                                      {capLabels.length > 0 ? (
                                        <div className="flex flex-wrap gap-x-2 gap-y-0.5">
                                          {capLabels.map((label) => (
                                            <span
                                              key={label}
                                              className="text-[10px] text-muted-foreground"
                                            >
                                              {label}
                                            </span>
                                          ))}
                                        </div>
                                      ) : null}
                                    </div>
                                  </TooltipPopup>
                                </Tooltip>
                              ) : null}
                              {model.isCustom ? (
                                <div className="ml-auto flex shrink-0 items-center gap-1.5">
                                  <span className="text-[10px] text-muted-foreground">custom</span>
                                  <button
                                    type="button"
                                    className="text-muted-foreground transition-colors hover:text-foreground"
                                    aria-label={`Remove ${model.slug}`}
                                    onClick={() =>
                                      removeCustomModel(providerCard.provider, model.slug)
                                    }
                                  >
                                    <XIcon className="size-3" />
                                  </button>
                                </div>
                              ) : null}
                            </div>
                          );
                        })}
                      </div>
                    </div>
                  </div>
                </CollapsibleContent>
              </Collapsible>
            </div>
          );
        })}
      </SettingsSection>

      <SettingsSection title="Advanced">
        <SettingsRow
          title="Keybindings"
          description="Open the persisted `keybindings.json` file to edit advanced bindings directly."
          status={
            <>
              <span className="block break-all font-mono text-[11px] text-foreground">
                {keybindingsConfigPath ?? "Resolving keybindings path..."}
              </span>
              {openKeybindingsError ? (
                <span className="mt-1 block text-destructive">{openKeybindingsError}</span>
              ) : (
                <span className="mt-1 block">Opens in your preferred editor.</span>
              )}
            </>
          }
          control={
            <Button
              size="xs"
              variant="outline"
              disabled={!keybindingsConfigPath || isOpeningKeybindings}
              onClick={openKeybindingsFile}
            >
              {isOpeningKeybindings ? "Opening..." : "Open file"}
            </Button>
          }
        />
      </SettingsSection>

      <SettingsSection title="About">
        {isElectron ? (
          <AboutVersionSection />
        ) : (
          <SettingsRow
            title={<AboutVersionTitle />}
            description="Current version of the application."
          />
        )}
      </SettingsSection>

      <footer className="pb-2 pt-4 text-center text-[11px] text-muted-foreground/60">
        <p>&copy; {new Date().getFullYear()} Shiori AI</p>
        <p className="mt-1">
          <Link
            to="/settings/credits"
            className="underline decoration-muted-foreground/30 underline-offset-2 transition-colors hover:text-muted-foreground"
          >
            Credits
          </Link>
        </p>
      </footer>
    </SettingsPageContainer>
  );
}

export function ArchivedThreadsPanel() {
  const projects = useStore((store) => store.projects);
  const threads = useStore((store) => store.threads);
  const appSettings = useSettings();
  const { unarchiveThread, deleteThread, confirmAndDeleteThread } = useThreadActions();
  const archivedGroups = useMemo(() => {
    const projectById = new Map(projects.map((project) => [project.id, project] as const));
    return [...projectById.values()]
      .map((project) => ({
        project,
        threads: threads
          .filter((thread) => thread.projectId === project.id && thread.archivedAt !== null)
          .toSorted((left, right) => {
            const leftKey = left.archivedAt ?? left.createdAt;
            const rightKey = right.archivedAt ?? right.createdAt;
            return rightKey.localeCompare(leftKey) || right.id.localeCompare(left.id);
          }),
      }))
      .filter((group) => group.threads.length > 0);
  }, [projects, threads]);

  const handleUnarchiveArchivedThread = useCallback(
    async (threadId: ThreadId) => {
      try {
        await unarchiveThread(threadId);
      } catch (error) {
        toastManager.add({
          type: "error",
          title: "Failed to unarchive thread",
          description: error instanceof Error ? error.message : "An error occurred.",
        });
      }
    },
    [unarchiveThread],
  );

  const handleDeleteArchivedThread = useCallback(
    async (threadId: ThreadId) => {
      try {
        await confirmAndDeleteThread(threadId);
      } catch (error) {
        toastManager.add({
          type: "error",
          title: "Failed to delete thread",
          description: error instanceof Error ? error.message : "An error occurred.",
        });
      }
    },
    [confirmAndDeleteThread],
  );

  const handleUnarchiveAllArchivedThreads = useCallback(
    async (projectName: string, projectThreads: readonly { id: ThreadId }[]) => {
      try {
        for (const thread of projectThreads) {
          await unarchiveThread(thread.id);
        }
      } catch (error) {
        toastManager.add({
          type: "error",
          title: `Failed to unarchive archived threads for ${projectName}`,
          description: error instanceof Error ? error.message : "An error occurred.",
        });
      }
    },
    [unarchiveThread],
  );

  const handleDeleteAllArchivedThreads = useCallback(
    async (projectName: string, projectThreads: readonly { id: ThreadId }[]) => {
      const api = readNativeApi();
      if (!api) return;
      const count = projectThreads.length;
      if (count === 0) return;

      try {
        if (appSettings.confirmThreadDelete) {
          const confirmed = await api.dialogs.confirm(
            [
              `Delete all ${count} archived thread${count === 1 ? "" : "s"} in "${projectName}"?`,
              "This permanently clears conversation history for these threads.",
            ].join("\n"),
          );
          if (!confirmed) {
            return;
          }
        }

        const deletedThreadIds = new Set<ThreadId>(projectThreads.map((thread) => thread.id));
        for (const thread of projectThreads) {
          await deleteThread(thread.id, { deletedThreadIds });
        }
      } catch (error) {
        toastManager.add({
          type: "error",
          title: `Failed to delete archived threads for ${projectName}`,
          description: error instanceof Error ? error.message : "An error occurred.",
        });
      }
    },
    [appSettings.confirmThreadDelete, deleteThread],
  );

  const handleArchivedThreadContextMenu = useCallback(
    async (threadId: ThreadId, position: { x: number; y: number }) => {
      const api = readNativeApi();
      if (!api) return;
      const clicked = await api.contextMenu.show(
        [
          { id: "unarchive", label: "Unarchive" },
          { id: "delete", label: "Delete", destructive: true },
        ],
        position,
      );

      if (clicked === "unarchive") {
        await handleUnarchiveArchivedThread(threadId);
        return;
      }

      if (clicked === "delete") {
        await handleDeleteArchivedThread(threadId);
      }
    },
    [handleDeleteArchivedThread, handleUnarchiveArchivedThread],
  );

  return (
    <SettingsPageContainer>
      {archivedGroups.length === 0 ? (
        <SettingsSection title="Archived threads">
          <Empty className="min-h-88">
            <EmptyMedia variant="icon">
              <ArchiveIcon />
            </EmptyMedia>
            <EmptyHeader>
              <EmptyTitle>No archived threads</EmptyTitle>
              <EmptyDescription>Archived threads will appear here.</EmptyDescription>
            </EmptyHeader>
          </Empty>
        </SettingsSection>
      ) : (
        archivedGroups.map(({ project, threads: projectThreads }) => (
          <SettingsSection
            key={project.id}
            title={project.name}
            icon={<ProjectFavicon cwd={project.cwd} />}
            headerAction={
              <div className="flex items-center gap-2">
                <Button
                  type="button"
                  variant="destructive-outline"
                  size="xs"
                  className="cursor-pointer"
                  aria-label={`Delete all archived threads for ${project.name}`}
                  onClick={() => void handleDeleteAllArchivedThreads(project.name, projectThreads)}
                >
                  Delete All
                </Button>
                <Button
                  type="button"
                  variant="outline"
                  size="xs"
                  className="cursor-pointer"
                  aria-label={`Unarchive all threads for ${project.name}`}
                  onClick={() =>
                    void handleUnarchiveAllArchivedThreads(project.name, projectThreads)
                  }
                >
                  Unarchive All
                </Button>
              </div>
            }
          >
            {projectThreads.map((thread) => (
              <div
                key={thread.id}
                className="flex items-center justify-between gap-3 border-t border-border px-4 py-3 first:border-t-0 sm:px-5"
                onContextMenu={(event) => {
                  event.preventDefault();
                  void handleArchivedThreadContextMenu(thread.id, {
                    x: event.clientX,
                    y: event.clientY,
                  });
                }}
              >
                <div className="min-w-0 flex-1">
                  <h3 className="truncate text-sm font-medium text-foreground">{thread.title}</h3>
                  <p className="text-xs text-muted-foreground">
                    Archived {formatRelativeTimeLabel(thread.archivedAt ?? thread.createdAt)}
                    {" \u00b7 Created "}
                    {formatRelativeTimeLabel(thread.createdAt)}
                  </p>
                </div>
                <div className="flex shrink-0 items-center gap-2">
                  <Button
                    type="button"
                    variant="destructive-outline"
                    size="sm"
                    className="h-7 cursor-pointer gap-1.5 px-2.5"
                    aria-label={`Delete archived thread ${thread.title}`}
                    onClick={() => void handleDeleteArchivedThread(thread.id)}
                  >
                    <Trash2 className="size-3.5" />
                    <span>Delete</span>
                  </Button>
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    className="h-7 cursor-pointer gap-1.5 px-2.5"
                    onClick={() => void handleUnarchiveArchivedThread(thread.id)}
                  >
                    <ArchiveX className="size-3.5" />
                    <span>Unarchive</span>
                  </Button>
                </div>
              </div>
            ))}
          </SettingsSection>
        ))
      )}
    </SettingsPageContainer>
  );
}
