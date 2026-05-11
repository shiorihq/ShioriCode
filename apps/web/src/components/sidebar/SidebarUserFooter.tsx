import { IconGearOutline24 as SettingsIcon } from "nucleo-core-outline-24";
import type { ReactNode } from "react";

import { useHostedShioriState } from "../../convex/HostedShioriProvider";
import type { HostedViewer } from "../../convex/api";
import { useSettings } from "../../hooks/useSettings";
import { getPersonalDetailsBlurClass } from "../../lib/personalDetails";
import { cn } from "../../lib/utils";
import { SidebarMenu, SidebarMenuButton, SidebarMenuItem } from "../ui/sidebar";

const SIDEBAR_HOVER_SURFACE_CLASS = "hover:bg-sidebar-hover hover:text-sidebar-hover-foreground";

function UserAvatar(props: {
  src: string | null | undefined;
  name: string | null | undefined;
  blurPersonalData: boolean;
}) {
  const initials = (props.name ?? "?").charAt(0).toUpperCase();
  const blurClassName = getPersonalDetailsBlurClass(props.blurPersonalData);

  return props.src ? (
    <img
      src={props.src}
      alt=""
      className={cn("size-6 shrink-0 rounded-md object-cover", blurClassName)}
      referrerPolicy="no-referrer"
    />
  ) : (
    <span
      className={cn(
        "flex size-6 shrink-0 items-center justify-center rounded-md bg-muted text-sm font-medium text-muted-foreground",
        blurClassName,
      )}
    >
      {initials}
    </span>
  );
}

export function SidebarUserFooterView(props: {
  isAuthenticated: boolean;
  viewer: HostedViewer | null | undefined;
  subscriptionPlanLabel: string | null;
  blurPersonalData: boolean;
  onSettingsClick: () => void;
  sortMenu?: ReactNode;
}) {
  if (!props.isAuthenticated || !props.viewer) {
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

  const displayName = props.viewer.name ?? props.viewer.email ?? "User";
  const blurClassName = getPersonalDetailsBlurClass(props.blurPersonalData);

  return (
    <div className="flex items-center gap-1.5">
      <button
        type="button"
        className={cn(
          "flex min-w-0 flex-1 items-center gap-2 rounded-lg px-2 py-1.5 text-left text-sidebar-foreground transition-colors group-data-[collapsible=icon]:justify-center group-data-[collapsible=icon]:px-0",
          SIDEBAR_HOVER_SURFACE_CLASS,
        )}
        onClick={props.onSettingsClick}
      >
        <span className="shrink-0">
          <UserAvatar
            src={props.viewer.image}
            name={props.viewer.name}
            blurPersonalData={props.blurPersonalData}
          />
        </span>
        <span className="flex min-w-0 flex-1 flex-col gap-0.5 group-data-[collapsible=icon]:hidden">
          <span
            className={cn(
              "block truncate text-xs font-medium text-sidebar-foreground",
              blurClassName,
            )}
          >
            {displayName}
          </span>
          {props.subscriptionPlanLabel ? (
            <span
              className={cn(
                "block truncate text-[10px] leading-tight text-sidebar-foreground/80",
                blurClassName,
              )}
            >
              {props.subscriptionPlanLabel}
            </span>
          ) : null}
        </span>
      </button>
      <div className="flex shrink-0 items-center gap-0.5 group-data-[collapsible=icon]:hidden">
        {props.sortMenu}
        <button
          type="button"
          className={cn(
            "inline-flex size-5 items-center justify-center rounded-md text-sidebar-foreground transition-colors",
            SIDEBAR_HOVER_SURFACE_CLASS,
          )}
          onClick={props.onSettingsClick}
        >
          <SettingsIcon className="size-3.5" />
        </button>
      </div>
    </div>
  );
}

export function SidebarUserFooter(props: { onSettingsClick: () => void; sortMenu?: ReactNode }) {
  const { isAuthenticated, viewer, subscriptionPlanLabel } = useHostedShioriState();
  const blurPersonalData = useSettings().blurPersonalData;

  return (
    <SidebarUserFooterView
      isAuthenticated={isAuthenticated}
      viewer={viewer}
      subscriptionPlanLabel={subscriptionPlanLabel}
      blurPersonalData={blurPersonalData}
      onSettingsClick={props.onSettingsClick}
      sortMenu={props.sortMenu}
    />
  );
}
