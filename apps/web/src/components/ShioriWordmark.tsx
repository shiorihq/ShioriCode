import { cn } from "../lib/utils";
import { AppLogoMark } from "./AppLogoMark";

export function ShioriWordmark(props?: { className?: string; logoClassName?: string }) {
  return (
    <span className={cn("flex shrink-0 items-center gap-2", props?.className)}>
      <AppLogoMark className={cn("size-5", props?.logoClassName)} />
      <span className="flex items-baseline gap-0.5">
        <span className="font-sans text-sm font-normal tracking-tight text-foreground">Shiori</span>
        <span className="font-mono text-sm font-bold italic text-primary">Code</span>
      </span>
    </span>
  );
}
