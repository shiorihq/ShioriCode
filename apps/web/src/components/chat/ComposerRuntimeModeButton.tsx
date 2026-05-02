import { RuntimeMode } from "contracts";
import { memo } from "react";
import { LockIcon, LockOpenIcon } from "lucide-react";
import { Button } from "../ui/button";
import { cn } from "~/lib/utils";
import { getRuntimeModeLabel, getRuntimeModeTitle } from "./runtimeModeLabels";

export const ComposerRuntimeModeButton = memo(function ComposerRuntimeModeButton(props: {
  compact: boolean;
  runtimeMode: RuntimeMode;
  onToggle: () => void;
}) {
  const isFullAccess = props.runtimeMode === "full-access";
  const label = getRuntimeModeLabel(props.runtimeMode);
  const title = getRuntimeModeTitle(props.runtimeMode);

  return (
    <Button
      variant="ghost"
      className={cn(
        "shrink-0 gap-1.5 whitespace-nowrap px-2 font-normal data-pressed:bg-accent/60 sm:px-2.5 [&_svg:not([class*='size-'])]:size-3.5",
        isFullAccess &&
          "text-orange-600 dark:text-orange-400 [&_svg:not([class*='opacity-'])]:opacity-100",
      )}
      size="sm"
      type="button"
      onClick={props.onToggle}
      title={title}
      aria-label={title}
    >
      {isFullAccess ? <LockOpenIcon /> : <LockIcon />}
      <span className="truncate">{label}</span>
    </Button>
  );
});
