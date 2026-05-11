import { IconSpinnerLoaderOutline24 as Loader2Icon } from "nucleo-core-outline-24";
import { cn } from "~/lib/utils";

function Spinner({ className, ...props }: React.ComponentProps<typeof Loader2Icon>) {
  return (
    <Loader2Icon
      aria-label="Loading"
      className={cn("animate-spin", className)}
      role="status"
      {...props}
    />
  );
}

export { Spinner };
