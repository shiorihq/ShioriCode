import type { ComponentType } from "react";
import {
  ArchiveIcon,
  ArrowLeftIcon,
  BarChart3Icon,
  BlocksIcon,
  MonitorIcon,
  MessageSquareIcon,
  PaletteIcon,
  Settings2Icon,
  SmartphoneIcon,
  UserIcon,
} from "lucide-react";
import { useNavigate } from "@tanstack/react-router";
import {
  readSettingsReturnPath,
  resolveSettingsBackNavigation,
} from "../../lib/settingsNavigation";
import { useHostedShioriState } from "../../convex/HostedShioriProvider";

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
  | "/settings/computer-use"
  | "/settings/mobile"
  | "/settings/usage"
  | "/settings/feedback";

type SettingsFeature = "computerUse" | "mobileApp";

export const SETTINGS_NAV_ITEMS: ReadonlyArray<{
  label: string;
  to: SettingsSectionPath;
  icon: ComponentType<{ className?: string }>;
  feature?: SettingsFeature;
}> = [
  { label: "General", to: "/settings/general", icon: Settings2Icon },
  { label: "Appearance", to: "/settings/appearance", icon: PaletteIcon },
  { label: "Skills & MCP", to: "/settings/skills", icon: BlocksIcon },
  { label: "Account", to: "/settings/account", icon: UserIcon },
  { label: "Usage", to: "/settings/usage", icon: BarChart3Icon },
  {
    label: "Mobile App",
    to: "/settings/mobile",
    icon: SmartphoneIcon,
    feature: "mobileApp",
  },
  {
    label: "Computer Use",
    to: "/settings/computer-use",
    icon: MonitorIcon,
    feature: "computerUse",
  },
  { label: "Archive", to: "/settings/archived", icon: ArchiveIcon },
  { label: "Feedback", to: "/settings/feedback", icon: MessageSquareIcon },
];

export function SettingsSidebarNav({ pathname }: { pathname: string }) {
  const navigate = useNavigate();
  const { computerUseEnabled, mobileAppEnabled } = useHostedShioriState();
  const navigateBack = () => {
    void navigate(resolveSettingsBackNavigation(readSettingsReturnPath()));
  };
  const itemClassName = "h-7 gap-1.5 px-2 py-0 text-left text-sm transition-none";
  const enabledFeatures = {
    computerUse: computerUseEnabled,
    mobileApp: mobileAppEnabled,
  } satisfies Record<SettingsFeature, boolean>;
  const visibleItems = SETTINGS_NAV_ITEMS.filter(
    (item) => item.feature === undefined || enabledFeatures[item.feature],
  );

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
          {visibleItems.map((item) => {
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
