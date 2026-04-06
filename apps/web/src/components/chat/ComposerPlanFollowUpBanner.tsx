import { memo } from "react";

export const ComposerPlanFollowUpBanner = memo(function ComposerPlanFollowUpBanner({
  planTitle,
}: {
  planTitle: string | null;
}) {
  return (
    <div className="px-4 py-3 sm:px-5 sm:py-3.5">
      <p className="truncate text-sm text-muted-foreground">
        Plan ready
        {planTitle ? (
          <>
            {" "}
            &mdash; <span className="font-medium text-foreground/80">{planTitle}</span>
          </>
        ) : null}
      </p>
    </div>
  );
});
