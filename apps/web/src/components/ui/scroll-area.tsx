"use client";

import { ScrollArea as ScrollAreaPrimitive } from "@base-ui/react/scroll-area";
import { useCallback, useState, type UIEvent } from "react";

import { cn } from "~/lib/utils";

function ScrollArea({
  className,
  children,
  scrollFade = false,
  scrollbarGutter = false,
  hideScrollbars = false,
  ...props
}: ScrollAreaPrimitive.Root.Props & {
  scrollFade?: boolean;
  scrollbarGutter?: boolean;
  hideScrollbars?: boolean;
}) {
  const [topFadeOpacity, setTopFadeOpacity] = useState(0);
  const [bottomFadeOpacity, setBottomFadeOpacity] = useState(0);

  const updateFadeOpacity = useCallback((el: HTMLElement) => {
    const fadeDistance = 56;
    const distanceFromTop = el.scrollTop;
    const distanceFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
    const toOpacity = (distance: number) => Math.max(0, Math.min(1, distance / fadeDistance));
    setTopFadeOpacity(toOpacity(distanceFromTop));
    setBottomFadeOpacity(toOpacity(distanceFromBottom));
  }, []);

  const handleViewportScroll = useCallback(
    (event: UIEvent<HTMLDivElement>) => {
      updateFadeOpacity(event.currentTarget);
    },
    [updateFadeOpacity],
  );

  const handleViewportRef = useCallback(
    (node: HTMLDivElement | null) => {
      if (node) updateFadeOpacity(node);
    },
    [updateFadeOpacity],
  );

  return (
    <ScrollAreaPrimitive.Root className={cn("relative size-full min-h-0", className)} {...props}>
      <ScrollAreaPrimitive.Viewport
        className={cn(
          "h-full overscroll-contain rounded-[inherit] outline-none transition-shadows focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background data-has-overflow-x:overscroll-x-contain",
          scrollbarGutter && "data-has-overflow-y:pe-2.5 data-has-overflow-x:pb-2.5",
          hideScrollbars &&
            "[-ms-overflow-style:none] [scrollbar-width:none] [&::-webkit-scrollbar]:hidden",
        )}
        onScroll={handleViewportScroll}
        ref={handleViewportRef}
        data-slot="scroll-area-viewport"
      >
        {children}
      </ScrollAreaPrimitive.Viewport>
      {scrollFade ? (
        <>
          <div
            aria-hidden="true"
            className="pointer-events-none absolute inset-x-0 top-0 h-6 rounded-t-[inherit] bg-linear-to-b from-background to-transparent"
            style={{ opacity: topFadeOpacity }}
          />
          <div
            aria-hidden="true"
            className="pointer-events-none absolute inset-x-0 bottom-0 h-6 rounded-b-[inherit] bg-linear-to-t from-background to-transparent"
            style={{ opacity: bottomFadeOpacity }}
          />
        </>
      ) : null}
      {!hideScrollbars && (
        <>
          <ScrollBar orientation="vertical" />
          <ScrollBar orientation="horizontal" />
          <ScrollAreaPrimitive.Corner data-slot="scroll-area-corner" />
        </>
      )}
    </ScrollAreaPrimitive.Root>
  );
}

function ScrollBar({
  className,
  orientation = "vertical",
  ...props
}: ScrollAreaPrimitive.Scrollbar.Props) {
  return (
    <ScrollAreaPrimitive.Scrollbar
      className={cn(
        "m-1 flex opacity-0 transition-opacity delay-300 data-[orientation=horizontal]:h-1.5 data-[orientation=vertical]:w-1.5 data-[orientation=horizontal]:flex-col data-hovering:opacity-100 data-scrolling:opacity-100 data-hovering:delay-0 data-scrolling:delay-0 data-hovering:duration-100 data-scrolling:duration-100",
        className,
      )}
      data-slot="scroll-area-scrollbar"
      orientation={orientation}
      {...props}
    >
      <ScrollAreaPrimitive.Thumb
        className="relative flex-1 rounded-full bg-foreground/20"
        data-slot="scroll-area-thumb"
      />
    </ScrollAreaPrimitive.Scrollbar>
  );
}

export { ScrollArea, ScrollBar };
