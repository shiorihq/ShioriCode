import {
  IconChevronDownOutline24 as ChevronDownIcon,
  IconGlobeOutline24 as GlobeIcon,
  IconMonitorOutline24 as ComputerIcon,
  IconPlusOutline24 as PlusIcon,
} from "nucleo-core-outline-24";

import {
  desktopRemoteLabel,
  LOCAL_DESKTOP_CONNECTION_VALUE,
  useDesktopRemoteConnection,
} from "~/hooks/useDesktopRemoteConnection";
import { cn } from "~/lib/utils";
import {
  Menu,
  MenuGroup,
  MenuGroupLabel,
  MenuItem,
  MenuPopup,
  MenuRadioGroup,
  MenuRadioItem,
  MenuSeparator,
  MenuTrigger,
} from "../ui/menu";
import { toastManager } from "../ui/toast";

export function SidebarRemoteSwitcher({ onManage }: { onManage: () => void }) {
  const { busy, connect, connection, label, loading, supported, useLocal } =
    useDesktopRemoteConnection();

  if (!supported) return null;

  const switchConnection = async (value: string) => {
    const switched =
      value === LOCAL_DESKTOP_CONNECTION_VALUE ? await useLocal() : await connect(value);
    if (!switched) {
      toastManager.add({
        type: "error",
        title: "Could not switch connection",
        description: "Check that the remote is online and try again.",
      });
    }
  };

  return (
    <Menu>
      <MenuTrigger
        aria-label={`Connected to ${label}`}
        className={cn(
          "group flex h-8 w-full min-w-0 items-center gap-2 rounded-md px-2 text-left text-sm text-foreground outline-hidden",
          "hover:bg-sidebar-hover hover:text-sidebar-hover-foreground focus-visible:ring-2 focus-visible:ring-sidebar-ring",
        )}
        disabled={busy || loading}
      >
        {connection.mode === "remote" ? (
          <GlobeIcon className="size-3.5 shrink-0 text-emerald-500" />
        ) : (
          <ComputerIcon className="size-3.5 shrink-0 text-muted-foreground" />
        )}
        <span className="min-w-0 flex-1 truncate">{loading ? "Loading connection…" : label}</span>
        <ChevronDownIcon className="size-3.5 shrink-0 text-muted-foreground transition-transform group-data-popup-open:rotate-180" />
      </MenuTrigger>
      <MenuPopup side="top" align="start" className="min-w-56">
        <MenuGroup>
          <MenuGroupLabel>Run ShioriCode on</MenuGroupLabel>
          <MenuRadioGroup
            value={connection.remoteUrl ?? LOCAL_DESKTOP_CONNECTION_VALUE}
            onValueChange={(value) => void switchConnection(value)}
          >
            <MenuRadioItem value={LOCAL_DESKTOP_CONNECTION_VALUE} disabled={busy}>
              This computer
            </MenuRadioItem>
            {connection.savedRemoteUrls.map((remoteUrl) => (
              <MenuRadioItem key={remoteUrl} value={remoteUrl} disabled={busy}>
                {desktopRemoteLabel(remoteUrl)}
              </MenuRadioItem>
            ))}
          </MenuRadioGroup>
        </MenuGroup>
        <MenuSeparator />
        <MenuItem onClick={onManage}>
          <PlusIcon />
          Add or manage remotes…
        </MenuItem>
      </MenuPopup>
    </Menu>
  );
}
