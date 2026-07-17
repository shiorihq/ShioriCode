import { SidebarMenu, SidebarMenuButton, SidebarMenuItem } from "../ui/sidebar";

export function SettingsShioriCodeLinkButton({ onClick }: { onClick: () => void }) {
  return (
    <SidebarMenu>
      <SidebarMenuItem>
        <SidebarMenuButton
          size="sm"
          tooltip="ShioriCode Link"
          className="gap-2 px-2 py-1.5 text-foreground"
          onClick={onClick}
        >
          <img
            src="/app-logo.png"
            alt=""
            className="size-3.5 shrink-0 rounded-[3px]"
            data-shioricode-link-logo
          />
          <span className="text-sm">ShioriCode Link</span>
        </SidebarMenuButton>
      </SidebarMenuItem>
    </SidebarMenu>
  );
}
