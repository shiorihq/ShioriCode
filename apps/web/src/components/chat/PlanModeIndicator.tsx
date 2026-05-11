import { memo } from "react";
import { IconXmarkOutline24 as XIcon } from "nucleo-core-outline-24";

interface PlanModeIndicatorProps {
  onDisable: () => void;
}

export const PlanModeIndicator = memo(function PlanModeIndicator({
  onDisable,
}: PlanModeIndicatorProps) {
  return (
    <button
      type="button"
      onClick={onDisable}
      title="Click to exit plan mode"
      className="group/plan flex cursor-pointer items-center gap-1 rounded-md bg-primary/8 px-1.5 py-0.5 transition-colors duration-120 hover:bg-primary/14"
    >
      <span className="text-xs font-medium text-primary">Plan</span>
      <XIcon className="size-3 text-primary/50 transition-colors group-hover/plan:text-primary" />
    </button>
  );
});
