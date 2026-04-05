import { memo } from "react";
import { SlidersHorizontalIcon, XCircleIcon } from "lucide-react";

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
      className="group/plan flex cursor-pointer items-center gap-1.5 rounded-full px-2 py-0.5 transition-colors duration-150 hover:bg-primary/10 sm:px-1.5"
    >
      <SlidersHorizontalIcon className="size-4 text-primary group-hover/plan:hidden" />
      <XCircleIcon className="hidden size-4 fill-primary text-white group-hover/plan:block" />
      <span className="text-sm font-medium text-primary">Plan</span>
    </button>
  );
});
