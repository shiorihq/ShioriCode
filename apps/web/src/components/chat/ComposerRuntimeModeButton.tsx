import { RuntimeMode } from "contracts";
import { memo } from "react";
import { LockIcon, LockOpenIcon } from "lucide-react";
import { Button } from "../ui/button";
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
      className="shrink-0 whitespace-nowrap px-2 text-muted-foreground/70 hover:text-foreground/80 sm:px-3"
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
