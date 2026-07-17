import type { ComponentType } from "react";
import {
  IconArchiveOutline24 as ArchiveIcon,
  IconArrowLeftOutline24 as ArrowLeftIcon,
  IconBoltOutline24 as McpIcon,
  IconBoxOutline24 as PluginsIcon,
  IconSparkleOutline24 as SkillsIcon,
  IconGlobeOutline24 as RemoteIcon,
  IconMonitorOutline24 as MonitorIcon,
  IconPaletteOutline24 as PaletteIcon,
  IconGear2Outline24 as Settings2Icon,
  IconMobileOutline24 as SmartphoneIcon,
} from "nucleo-core-outline-24";
import { useNavigate } from "@tanstack/react-router";
import {
  readSettingsReturnPath,
  resolveSettingsBackNavigation,
} from "../../lib/settingsNavigation";

import {
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupLabel,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
} from "../ui/sidebar";
import { SettingsShioriCodeLinkButton } from "./SettingsShioriCodeLinkButton";

export type SettingsSectionPath =
  | "/settings/general"
  | "/settings/appearance"
  | "/settings/skills"
  | "/settings/mcp"
  | "/settings/plugins"
  | "/settings/archived"
  | "/settings/computer-use"
  | "/settings/mobile"
  | "/settings/remote";

type SettingsNavItem = {
  label: string;
  to: SettingsSectionPath;
  icon: ComponentType<{ className?: string }>;
};

export const SETTINGS_NAV_SECTIONS: ReadonlyArray<{
  label: string;
  items: ReadonlyArray<SettingsNavItem>;
}> = [
  {
    label: "Personal",
    items: [
      { label: "General", to: "/settings/general", icon: Settings2Icon },
      { label: "Appearance", to: "/settings/appearance", icon: PaletteIcon },
    ],
  },
  {
    label: "Coding",
    items: [
      { label: "Skills", to: "/settings/skills", icon: SkillsIcon },
      { label: "MCP", to: "/settings/mcp", icon: McpIcon },
      {
        label: "Computer Use",
        to: "/settings/computer-use",
        icon: MonitorIcon,
      },
    ],
  },
  {
    label: "Integrations",
    items: [
      { label: "Plugins", to: "/settings/plugins", icon: PluginsIcon },
      {
        label: "Mobile App",
        to: "/settings/mobile",
        icon: SmartphoneIcon,
      },
      {
        label: "Remote",
        to: "/settings/remote",
        icon: RemoteIcon,
      },
    ],
  },
  {
    label: "Workspace",
    items: [{ label: "Archive", to: "/settings/archived", icon: ArchiveIcon }],
  },
];

export function SettingsSidebarNav({ pathname }: { pathname: string }) {
  const navigate = useNavigate();
  const navigateBack = () => {
    void navigate(resolveSettingsBackNavigation(readSettingsReturnPath()));
  };
  const itemClassName = "h-7 gap-1.5 px-2 py-0 text-left text-sm transition-none";

  return (
    <>
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
        {SETTINGS_NAV_SECTIONS.map((section) => (
          <SidebarGroup key={section.label} className="px-2 pt-3 pb-0 last:pb-3">
            <SidebarGroupLabel className="h-7 px-2 font-medium text-muted-foreground text-xs">
              {section.label}
            </SidebarGroupLabel>
            <SidebarMenu>
              {section.items.map((item) => {
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
        ))}
      </SidebarContent>
      <SidebarFooter className="mt-auto p-2 pt-1">
        <SettingsShioriCodeLinkButton
          onClick={() => void navigate({ to: "/settings/remote", replace: true })}
        />
      </SidebarFooter>
    </>
  );
}
