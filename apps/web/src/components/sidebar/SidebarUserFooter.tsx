import { IconGearOutline24 as SettingsIcon } from "nucleo-core-outline-24";
import type { ReactNode } from "react";

import { SidebarMenu, SidebarMenuButton, SidebarMenuItem } from "../ui/sidebar";

export function SidebarUserFooter(props: { onSettingsClick: () => void; sortMenu?: ReactNode }) {
  return (
    <div className="flex items-center gap-1">
      {props.sortMenu}
      <SidebarMenu className="flex-1">
        <SidebarMenuItem>
          <SidebarMenuButton
            size="sm"
            tooltip="Settings"
            className="gap-2 px-2 py-1.5 text-foreground"
            onClick={props.onSettingsClick}
          >
            <SettingsIcon className="size-3.5" />
            <span className="text-sm">Settings</span>
          </SidebarMenuButton>
        </SidebarMenuItem>
      </SidebarMenu>
    </div>
  );
}
