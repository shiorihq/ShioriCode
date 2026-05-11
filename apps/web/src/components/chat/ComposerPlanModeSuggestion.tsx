import { IconXmarkOutline24 as XIcon } from "nucleo-core-outline-24";
import { memo } from "react";
import { isMacPlatform } from "~/lib/utils";

const modKey = isMacPlatform(navigator.platform) ? "\u2318" : "Ctrl";

interface ComposerPlanModeSuggestionProps {
  onActivate: () => void;
  onDismiss: () => void;
}

export const ComposerPlanModeSuggestion = memo(function ComposerPlanModeSuggestion({
  onActivate,
  onDismiss,
}: ComposerPlanModeSuggestionProps) {
  return (
    <div className="flex items-center justify-center pb-1.5">
      <div className="flex items-center gap-2 text-xs text-muted-foreground/70">
        <button
          type="button"
          onClick={onActivate}
          className="rounded-md px-1.5 py-0.5 font-medium text-primary/80 transition-colors hover:bg-primary/8 hover:text-primary"
        >
          Plan mode
        </button>
        <kbd className="font-mono text-[10px] text-muted-foreground/40">{modKey}+Shift+P</kbd>
        <button
          type="button"
          onClick={onDismiss}
          className="text-muted-foreground/30 transition-colors hover:text-muted-foreground/60"
        >
          <XIcon className="size-3" />
        </button>
      </div>
    </div>
  );
});
