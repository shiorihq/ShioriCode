import { SlidersHorizontalIcon, XIcon } from "lucide-react";
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
    <div className="flex items-center justify-center pb-2">
      <div className="flex items-center gap-3 rounded-full border border-border/70 bg-card px-4 py-1.5 shadow-xs dark:bg-muted/40">
        <div className="flex items-center gap-2">
          <SlidersHorizontalIcon className="size-4 text-muted-foreground" />
          <span className="text-sm font-medium text-foreground">Create a plan</span>
          <kbd className="rounded-md border border-border/60 bg-muted/60 px-1.5 py-px font-mono text-xs text-muted-foreground">
            {modKey} + Shift + P
          </kbd>
        </div>
        <button
          type="button"
          onClick={onActivate}
          className="rounded-md bg-muted/80 px-2.5 py-0.5 text-sm font-medium text-foreground transition-colors hover:bg-muted"
        >
          Use plan mode
        </button>
        <button
          type="button"
          onClick={onDismiss}
          className="text-muted-foreground transition-colors hover:text-foreground"
        >
          <XIcon className="size-3.5" />
        </button>
      </div>
    </div>
  );
});
