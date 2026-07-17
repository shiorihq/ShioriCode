import { IconMonitorOutline24 as ComputerIcon } from "nucleo-core-outline-24";
import { useState } from "react";

import { useDesktopRemoteConnection } from "~/hooks/useDesktopRemoteConnection";

import { Alert, AlertDescription } from "../ui/alert";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Label } from "../ui/label";
import { SettingsRow, SettingsSection } from "./SettingsPanels";

export function DesktopRemoteConnectionCard() {
  const { busy, connect, error, label, supported } = useDesktopRemoteConnection();
  const [url, setUrl] = useState("");

  if (!supported) return null;

  return (
    <SettingsSection title="Connection" icon={<ComputerIcon className="size-3.5" />}>
      <SettingsRow
        title="Run ShioriCode on"
        description="Add a server here, then switch between environments from the main sidebar."
        status={label}
      >
        {error ? (
          <Alert variant="error" className="mb-3">
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        ) : null}

        <div className="grid gap-3">
          <div className="space-y-1.5">
            <Label htmlFor="desktop-remote-url">Add a remote</Label>
            <div className="flex gap-2">
              <Input
                id="desktop-remote-url"
                type="url"
                inputMode="url"
                placeholder="sc-….link.shiori.codes"
                value={url}
                disabled={busy}
                onChange={(event) => setUrl(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter" && url.trim()) void connect(url.trim());
                }}
              />
              <Button disabled={busy || !url.trim()} onClick={() => void connect(url.trim())}>
                {busy ? "Connecting…" : "Connect"}
              </Button>
            </div>
          </div>
        </div>
      </SettingsRow>
    </SettingsSection>
  );
}
