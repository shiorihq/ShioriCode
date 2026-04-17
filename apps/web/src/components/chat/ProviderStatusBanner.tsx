import { PROVIDER_DISPLAY_NAMES, type ServerProvider } from "contracts";
import { memo } from "react";
import { Alert, AlertAction, AlertDescription, AlertTitle } from "../ui/alert";
import { CircleAlertIcon, SettingsIcon } from "lucide-react";
import { Link } from "@tanstack/react-router";

export const ProviderStatusBanner = memo(function ProviderStatusBanner({
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

  return (
    <div className="pt-3 mx-auto max-w-3xl">
      <Alert variant={status.status === "error" ? "error" : "warning"}>
        <CircleAlertIcon />
        <AlertTitle>{title}</AlertTitle>
        <AlertDescription className="line-clamp-3" title={status.message ?? defaultMessage}>
          {status.message ?? defaultMessage}
        </AlertDescription>
        <AlertAction>
          <Link
            to="/settings/general"
            className="inline-flex items-center gap-1 rounded-md text-xs font-medium text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
          >
            <SettingsIcon className="size-3" />
            Settings
          </Link>
        </AlertAction>
      </Alert>
    </div>
  );
});
