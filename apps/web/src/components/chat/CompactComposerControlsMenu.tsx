import { type RuntimeMode } from "contracts";
import { memo, type ReactNode } from "react";
import {
  IconDotsOutline24 as EllipsisIcon,
  IconListTodoOutline24 as ListTodoIcon,
} from "nucleo-core-outline-24";
import { Button } from "../ui/button";
import {
  Menu,
  MenuGroup,
  MenuItem,
  MenuPopup,
  MenuRadioGroup,
  MenuRadioItem,
  MenuSeparator as MenuDivider,
  MenuTrigger,
} from "../ui/menu";
import { getRuntimeModeLabel } from "./runtimeModeLabels";

export const CompactComposerControlsMenu = memo(function CompactComposerControlsMenu(props: {
  activePlan: boolean;
  planSidebarOpen: boolean;
  runtimeMode: RuntimeMode;
  traitsMenuContent?: ReactNode;
  onTogglePlanSidebar: () => void;
  onRuntimeModeChange: (mode: RuntimeMode) => void;
}) {
  if (!props.traitsMenuContent && !props.activePlan) {
    return null;
  }

  return (
    <Menu>
      <MenuTrigger
        render={
          <Button
            size="sm"
            variant="ghost"
            className="shrink-0 px-2 text-muted-foreground/70 hover:text-foreground/80"
            aria-label="More composer controls"
          />
        }
      >
        <EllipsisIcon aria-hidden="true" className="size-4" />
      </MenuTrigger>
      <MenuPopup align="start">
        <MenuGroup>
          <div className="px-2 py-1.5 font-medium text-muted-foreground text-xs">Access</div>
          <MenuRadioGroup
            value={props.runtimeMode}
            onValueChange={(value) => {
              if (value === "approval-required" || value === "full-access") {
                props.onRuntimeModeChange(value);
              }
            }}
          >
            <MenuRadioItem value="approval-required">
              {getRuntimeModeLabel("approval-required")}
            </MenuRadioItem>
            <MenuRadioItem value="full-access">{getRuntimeModeLabel("full-access")}</MenuRadioItem>
          </MenuRadioGroup>
        </MenuGroup>

        {props.traitsMenuContent ? (
          <>
            <MenuDivider />
            {props.traitsMenuContent}
          </>
        ) : null}
        {props.activePlan ? (
          <>
            <MenuDivider />
            <MenuItem onClick={props.onTogglePlanSidebar}>
              <ListTodoIcon className="size-4 shrink-0" />
              {props.planSidebarOpen ? "Hide plan sidebar" : "Show plan sidebar"}
            </MenuItem>
          </>
        ) : null}
      </MenuPopup>
    </Menu>
  );
});
