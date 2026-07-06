import { type HTMLAttributes } from "react";

import { cn } from "~/lib/utils";

/**
 * Card shell for panels docked above the composer frame. Docked panels stack
 * directly on top of one another, and only the topmost rendered panel may
 * round its top corners — the sibling selector derives that from render
 * order, so panels never need to know which siblings are currently visible.
 */
export function ComposerDockedPanel({ className, ...rest }: HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      data-composer-docked-panel="true"
      className={cn(
        "relative z-0 mx-auto w-[calc(100%-3rem)] max-w-[39rem] min-w-0 overflow-hidden rounded-t-[16px] rounded-b-none border border-b-0 border-border bg-card sm:w-[calc(100%-4rem)]",
        "[[data-composer-docked-panel]~&]:rounded-t-none [[data-composer-docked-panel]~&]:border-t-border/40",
        className,
      )}
      {...rest}
    />
  );
}
