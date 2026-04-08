import { memo } from "react";

export const ComposerPlanFollowUpBanner = memo(function ComposerPlanFollowUpBanner({
  planTitle,
}: {
  planTitle: string | null;
}) {
  return (
    <div className="px-4 py-2 sm:px-5">
      <p className="truncate text-xs text-muted-foreground/60">
        Plan ready
        {planTitle ? (
          <>
            {" — "}
            <span className="text-foreground/60">{planTitle}</span>
          </>
        ) : null}
      </p>
    </div>
  );
});
