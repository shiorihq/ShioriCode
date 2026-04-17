import type { ComponentType } from "react";
import {
  ArchiveIcon,
  ArrowLeftIcon,
  BarChart3Icon,
  BlocksIcon,
  MessageSquareIcon,
  PaletteIcon,
  Settings2Icon,
  UserIcon,
} from "lucide-react";
import { useNavigate } from "@tanstack/react-router";
import {
  readSettingsReturnPath,
  resolveSettingsBackNavigation,
} from "../../lib/settingsNavigation";

import {
  SidebarContent,
  SidebarGroup,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
} from "../ui/sidebar";

export type SettingsSectionPath =
  | "/settings/general"
  | "/settings/appearance"
  | "/settings/skills"
  | "/settings/account"
  | "/settings/archived"
  | "/settings/usage"
  | "/settings/feedback";

export const SETTINGS_NAV_ITEMS: ReadonlyArray<{
  label: string;
  to: SettingsSectionPath;
  icon: ComponentType<{ className?: string }>;
}> = [
  { label: "General", to: "/settings/general", icon: Settings2Icon },
  { label: "Appearance", to: "/settings/appearance", icon: PaletteIcon },
  { label: "Skills & MCP", to: "/settings/skills", icon: BlocksIcon },
  { label: "Account", to: "/settings/account", icon: UserIcon },
  { label: "Usage", to: "/settings/usage", icon: BarChart3Icon },
  { label: "Archive", to: "/settings/archived", icon: ArchiveIcon },
  { label: "Feedback", to: "/settings/feedback", icon: MessageSquareIcon },
];

export function SettingsSidebarNav({ pathname }: { pathname: string }) {
  const navigate = useNavigate();
  const navigateBack = () => {
    void navigate(resolveSettingsBackNavigation(readSettingsReturnPath()));
  };
  const itemClassName = "gap-2 px-2 py-2 text-left text-sm transition-none";

  return (
    <SidebarContent className="overflow-x-hidden">
      <SidebarGroup className="px-2 pt-3 pb-0">
        <SidebarMenu>
          <SidebarMenuItem>
            <SidebarMenuButton size="sm" className={itemClassName} onClick={navigateBack}>
              <ArrowLeftIcon className="size-4" />
              <span>Back</span>
            </SidebarMenuButton>
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarGroup>
      <SidebarGroup className="px-2 py-3">
        <SidebarMenu>
          {SETTINGS_NAV_ITEMS.map((item) => {
            const Icon = item.icon;
            const isActive = pathname === item.to;
            return (
              <SidebarMenuItem key={item.to}>
                <SidebarMenuButton
                  size="sm"
                  isActive={isActive}
                  className={itemClassName}
                  onClick={() => void navigate({ to: item.to, replace: true })}
                >
                  <Icon className="size-4 shrink-0" />
                  <span className="truncate">{item.label}</span>
                </SidebarMenuButton>
              </SidebarMenuItem>
            );
          })}
        </SidebarMenu>
      </SidebarGroup>
    </SidebarContent>
  );
}
