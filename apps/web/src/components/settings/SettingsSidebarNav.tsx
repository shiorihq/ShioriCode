import type { ComponentType } from "react";
import {
  IconArchiveOutline24 as ArchiveIcon,
  IconArrowLeftOutline24 as ArrowLeftIcon,
  IconBoltOutline24 as McpIcon,
  IconBoxOutline24 as PluginsIcon,
  IconSparkleOutline24 as SkillsIcon,
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
import { useMobileAppFeatureEnabled } from "../../featureFlags";

import {
  SidebarContent,
  SidebarGroup,
  SidebarGroupLabel,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
} from "../ui/sidebar";

export type SettingsSectionPath =
  | "/settings/general"
  | "/settings/appearance"
  | "/settings/skills"
  | "/settings/mcp"
  | "/settings/plugins"
  | "/settings/archived"
  | "/settings/computer-use"
  | "/settings/mobile";

type SettingsFeature = "mobileApp";

type SettingsNavItem = {
  label: string;
  to: SettingsSectionPath;
  icon: ComponentType<{ className?: string }>;
  feature?: SettingsFeature;
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
        feature: "mobileApp",
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
  const mobileAppEnabled = useMobileAppFeatureEnabled();
  const navigateBack = () => {
    void navigate(resolveSettingsBackNavigation(readSettingsReturnPath()));
  };
  const itemClassName = "h-7 gap-1.5 px-2 py-0 text-left text-sm transition-none";
  const enabledFeatures = {
    mobileApp: mobileAppEnabled,
  } satisfies Record<SettingsFeature, boolean>;
  const visibleSections = SETTINGS_NAV_SECTIONS.map((section) => ({
    label: section.label,
    items: section.items.filter(
      (item) => item.feature === undefined || enabledFeatures[item.feature],
    ),
  })).filter((section) => section.items.length > 0);

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
      {visibleSections.map((section) => (
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
  );
}
