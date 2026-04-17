import { cn } from "../lib/utils";

export function ShioriWordmark(props?: { className?: string }) {
  return (
    <span className={cn("flex shrink-0 items-baseline gap-0.5", props?.className)}>
      <span className="font-sans text-sm font-normal tracking-tight text-foreground">Shiori</span>
      <span className="font-mono text-sm font-bold italic text-primary">Code</span>
    </span>
  );
}
