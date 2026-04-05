import type { ComponentType } from "react";
import {
  ArchiveIcon,
  ArrowLeftIcon,
  BarChart3Icon,
  MessageSquareIcon,
  Settings2Icon,
  UserIcon,
} from "lucide-react";
import { useNavigate } from "@tanstack/react-router";

import {
  SidebarContent,
  SidebarGroup,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarSeparator,
} from "../ui/sidebar";

export type SettingsSectionPath =
  | "/settings/general"
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
  { label: "Account", to: "/settings/account", icon: UserIcon },
  { label: "Usage", to: "/settings/usage", icon: BarChart3Icon },
  { label: "Archive", to: "/settings/archived", icon: ArchiveIcon },
  { label: "Feedback", to: "/settings/feedback", icon: MessageSquareIcon },
];

export function SettingsSidebarNav({ pathname }: { pathname: string }) {
  const navigate = useNavigate();

  return (
    <SidebarContent className="overflow-x-hidden">
      <SidebarGroup className="px-2 pt-3 pb-0">
        <SidebarMenu>
          <SidebarMenuItem>
            <SidebarMenuButton
              size="sm"
              className="gap-2 px-2 py-2 text-xs text-muted-foreground hover:bg-accent hover:text-foreground"
              onClick={() => window.history.back()}
            >
              <ArrowLeftIcon className="size-4" />
              <span>Back</span>
            </SidebarMenuButton>
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarGroup>

      <SidebarSeparator />

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
                  className={
                    isActive
                      ? "gap-2 px-2 py-2 text-left text-xs text-foreground"
                      : "gap-2 px-2 py-2 text-left text-xs text-muted-foreground hover:text-foreground/80"
                  }
                  onClick={() => void navigate({ to: item.to, replace: true })}
                >
                  <Icon
                    className={
                      isActive
                        ? "size-4 shrink-0 text-foreground"
                        : "size-4 shrink-0 text-muted-foreground"
                    }
                  />
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
