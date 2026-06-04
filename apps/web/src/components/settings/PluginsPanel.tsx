import { useCallback } from "react";
import {
  IconBoxOutline24 as PluginsIcon,
  IconExternalLinkOutline24 as ExternalLinkIcon,
  IconPlusOutline24 as PlusIcon,
  IconTrash2Outline24 as Trash2Icon,
} from "nucleo-core-outline-24";
import type { McpServerEntry } from "contracts";

import { ensureNativeApi } from "../../nativeApi";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Switch } from "../ui/switch";
import { toastManager } from "../ui/toast";
import { SettingsPageContainer, SettingsSection } from "./SettingsPanels";
import { getConnectorIcon } from "./connectorIcons";
import {
  MARKETPLACE_CONNECTORS,
  getInstalledMarketplaceServer,
  installMarketplaceConnector,
  setMarketplaceConnectorEnabled,
  uninstallMarketplaceConnector,
} from "./connectorMarketplace";
import { useMcpServerSettings } from "./skillsMcpShared";

// ── Plugin Marketplace Section ──────────────────────────────────

function ConnectorMarketplaceSection({
  servers,
  onInstall,
  onToggle,
  onUninstall,
}: {
  servers: readonly McpServerEntry[];
  onInstall: (connectorId: string) => void;
  onToggle: (connectorId: string, enabled: boolean) => void;
  onUninstall: (connectorId: string) => void;
}) {
  const openDocs = useCallback((url: string) => {
    void ensureNativeApi()
      .shell.openExternal(url)
      .catch(() => {
        window.open(url, "_blank", "noopener,noreferrer");
      });
  }, []);

  return (
    <SettingsSection title="Plugin Marketplace" icon={<PluginsIcon className="size-3.5" />}>
      <div className="divide-y divide-border">
        {MARKETPLACE_CONNECTORS.map((connector) => {
          const installed = getInstalledMarketplaceServer(servers, connector.id);
          const enabled = installed?.enabled ?? false;
          const ConnectorIcon = getConnectorIcon(connector.id);
          return (
            <div
              key={connector.id}
              className="grid gap-3 px-4 py-3.5 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-center sm:px-5"
            >
              <div className="flex min-w-0 items-start gap-3">
                <span className="mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-lg border bg-card text-foreground">
                  <ConnectorIcon className="size-4" />
                </span>
                <div className="min-w-0 space-y-2">
                  <div className="flex min-w-0 flex-wrap items-center gap-2">
                    <h3 className="min-w-0 text-sm font-medium text-foreground">
                      {connector.name}
                    </h3>
                    <Badge variant="secondary" className="text-[10px]">
                      {connector.category}
                    </Badge>
                    {installed ? (
                      <Badge variant={enabled ? "default" : "outline"} className="text-[10px]">
                        {enabled ? "Enabled" : "Installed"}
                      </Badge>
                    ) : null}
                  </div>
                  <p className="max-w-[42rem] text-xs leading-5 text-muted-foreground">
                    {connector.summary}
                  </p>
                  <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-muted-foreground">
                    <span className="min-w-0 truncate font-mono">{connector.commandPreview}</span>
                    {connector.requiredEnvironment?.length ? (
                      <span className="shrink-0">
                        Requires {connector.requiredEnvironment.join(", ")}
                      </span>
                    ) : null}
                  </div>
                </div>
              </div>

              <div className="flex min-w-0 items-center gap-2 sm:justify-end">
                {connector.docsUrl ? (
                  <Button
                    size="icon-xs"
                    variant="ghost"
                    aria-label={`Open ${connector.name} connector documentation`}
                    onClick={() => openDocs(connector.docsUrl)}
                  >
                    <ExternalLinkIcon className="size-3.5 text-muted-foreground" />
                  </Button>
                ) : null}
                {installed ? (
                  <>
                    <Switch
                      checked={enabled}
                      onCheckedChange={(checked) => onToggle(connector.id, checked)}
                    />
                    <Button
                      size="icon-xs"
                      variant="ghost"
                      aria-label={`Uninstall ${connector.name} connector`}
                      onClick={() => onUninstall(connector.id)}
                    >
                      <Trash2Icon className="size-3.5 text-muted-foreground" />
                    </Button>
                  </>
                ) : (
                  <Button
                    size="sm"
                    variant="outline"
                    className="gap-1.5"
                    onClick={() => onInstall(connector.id)}
                  >
                    <PlusIcon className="size-3.5" />
                    Install
                  </Button>
                )}
              </div>
            </div>
          );
        })}
      </div>
    </SettingsSection>
  );
}

// ── Main Panel ───────────────────────────────────────────────────

export function PluginsPanel() {
  const { servers, persistServers } = useMcpServerSettings();

  const handleInstallConnector = useCallback(
    (connectorId: string) => {
      persistServers(installMarketplaceConnector(servers, connectorId));
      const connector = MARKETPLACE_CONNECTORS.find((item) => item.id === connectorId);
      toastManager.add({
        type: "success",
        title: connector ? `Installed ${connector.name}` : "Installed connector",
      });
    },
    [persistServers, servers],
  );

  const handleToggleConnector = useCallback(
    (connectorId: string, enabled: boolean) => {
      persistServers(setMarketplaceConnectorEnabled(servers, connectorId, enabled));
    },
    [persistServers, servers],
  );

  const handleUninstallConnector = useCallback(
    (connectorId: string) => {
      persistServers(uninstallMarketplaceConnector(servers, connectorId));
    },
    [persistServers, servers],
  );

  return (
    <SettingsPageContainer>
      <ConnectorMarketplaceSection
        servers={servers}
        onInstall={handleInstallConnector}
        onToggle={handleToggleConnector}
        onUninstall={handleUninstallConnector}
      />
    </SettingsPageContainer>
  );
}
