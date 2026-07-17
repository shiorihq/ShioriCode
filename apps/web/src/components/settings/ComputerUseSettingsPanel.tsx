import { IconMonitorOutline24 as MonitorIcon } from "nucleo-core-outline-24";

import { useSettings, useUpdateSettings } from "../../hooks/useSettings";
import { readNativeApi } from "../../nativeApi";
import { Switch } from "../ui/switch";
import { SettingsPageContainer, SettingsSection, SettingsRow } from "./SettingsPanels";

export function ComputerUseSettingsPanel() {
  const settings = useSettings();
  const { updateSettings } = useUpdateSettings();

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

  return (
    <SettingsPageContainer>
      <SettingsSection title="Computer Use" icon={<MonitorIcon className="size-3.5" />}>
        <SettingsRow
          title="Enable Computer Use"
          description="Allow agents to see and control this Mac using screenshots, the pointer, keyboard, and scrolling."
          control={
            <Switch
              checked={settings.computerUse.enabled}
              onCheckedChange={(checked) => setComputerUseEnabled(Boolean(checked))}
              aria-label="Enable Computer Use"
            />
          }
        />
      </SettingsSection>
    </SettingsPageContainer>
  );
}
