"use client";

import {
  useCallback,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
  type UIEvent,
} from "react";

import { cn } from "~/lib/utils";

/** Scroll offset below which the viewport counts as flush with the top edge. */
const TOP_EDGE_EPSILON_PX = 2;
/** Distance from the bottom within which streaming follow re-engages. */
const FOLLOW_RESUME_THRESHOLD_PX = 24;

const VIEWPORT_ATTRIBUTE = "data-item-clamped-viewport";
const ITEM_ATTRIBUTE = "data-item-clamped-viewport-item";

interface ItemClampedScrollViewportProps {
  children: ReactNode;
  className?: string;
  /** Number of rendered items; a change triggers re-measurement. */
  itemCount: number;
  /** Max items visible at once before the viewport scrolls internally. */
  maxVisibleItems: number;
  /** Keep the newest (bottom) item in view while items stream in. */
  followBottom?: boolean;
  /** Notifies height-measuring ancestors (e.g. virtualized lists) when the clamp changes. */
  onClampChange?: (() => void) | undefined;
}

/**
 * Scroll viewport that shows at most `maxVisibleItems` items at once, where
 * each direct item is marked with `data-item-clamped-viewport-item`. The clamp
 * is derived from measured item heights — never a fixed pixel cap — so an item
 * that expands in place (e.g. an opened tool call) always fits the viewport
 * instead of being cut off. When content is scrolled out above, a blur
 * gradient marks the top edge.
 */
export function ItemClampedScrollViewport({
  children,
  className,
  followBottom = false,
  itemCount,
  maxVisibleItems,
  onClampChange,
}: ItemClampedScrollViewportProps) {
  const viewportRef = useRef<HTMLDivElement | null>(null);
  const [maxHeight, setMaxHeight] = useState<number | null>(null);
  const [hasContentAbove, setHasContentAbove] = useState(false);
  const followPausedRef = useRef(false);
  const lastScrollTopRef = useRef(0);

  // A fresh streaming run re-engages follow even if the user scrolled up
  // during the previous one.
  useLayoutEffect(() => {
    if (followBottom) {
      followPausedRef.current = false;
    }
  }, [followBottom]);

  const syncScrollState = useCallback((viewport: HTMLElement) => {
    setHasContentAbove(viewport.scrollTop > TOP_EDGE_EPSILON_PX);
  }, []);

  const followIfEngaged = useCallback(
    (viewport: HTMLElement) => {
      if (followBottom && !followPausedRef.current) {
        viewport.scrollTop = viewport.scrollHeight;
        lastScrollTopRef.current = viewport.scrollTop;
      }
    },
    [followBottom],
  );

  useLayoutEffect(() => {
    const viewport = viewportRef.current;
    if (!viewport) {
      return;
    }

    const measure = () => {
      const items = collectOwnItems(viewport);
      setMaxHeight(computeClampHeight(items, maxVisibleItems));
      followIfEngaged(viewport);
      syncScrollState(viewport);
    };

    measure();
    if (typeof ResizeObserver === "undefined") {
      return;
    }
    const observer = new ResizeObserver(measure);
    for (const item of collectOwnItems(viewport)) {
      observer.observe(item);
    }
    return () => observer.disconnect();
  }, [followIfEngaged, itemCount, maxVisibleItems, syncScrollState]);

  // Runs after the new clamp is applied to the DOM, so following lands on the
  // true bottom and ancestors measure the settled height.
  useLayoutEffect(() => {
    const viewport = viewportRef.current;
    if (viewport) {
      followIfEngaged(viewport);
      syncScrollState(viewport);
    }
    onClampChange?.();
  }, [followIfEngaged, maxHeight, onClampChange, syncScrollState]);

  const handleScroll = (event: UIEvent<HTMLDivElement>) => {
    const viewport = event.currentTarget;
    if (followBottom) {
      const scrolledUp = viewport.scrollTop < lastScrollTopRef.current - 1;
      if (scrolledUp) {
        followPausedRef.current = true;
      } else if (
        viewport.scrollHeight - viewport.scrollTop - viewport.clientHeight <=
        FOLLOW_RESUME_THRESHOLD_PX
      ) {
        followPausedRef.current = false;
      }
    }
    lastScrollTopRef.current = viewport.scrollTop;
    syncScrollState(viewport);
  };

  return (
    <div className={cn("relative", className)}>
      <div
        ref={viewportRef}
        {...{ [VIEWPORT_ATTRIBUTE]: "" }}
        className={cn(
          "overflow-y-auto overscroll-contain scrollbar-thin scrollbar-thumb-border/70 scrollbar-track-transparent",
          maxHeight !== null && "pr-1",
        )}
        style={maxHeight === null ? undefined : { maxHeight }}
        onScroll={handleScroll}
      >
        {children}
      </div>
      <div
        aria-hidden="true"
        className={cn(
          "pointer-events-none absolute inset-x-0 top-0 h-8 bg-gradient-to-b from-background/60 to-transparent backdrop-blur-sm transition-opacity duration-150",
          hasContentAbove ? "opacity-100" : "opacity-0",
        )}
        style={{
          maskImage: "linear-gradient(to bottom, black 25%, transparent 100%)",
          WebkitMaskImage: "linear-gradient(to bottom, black 25%, transparent 100%)",
        }}
      />
    </div>
  );
}

/** Items belonging to this viewport, excluding items of nested viewports. */
function collectOwnItems(viewport: HTMLElement): HTMLElement[] {
  return Array.from(viewport.querySelectorAll<HTMLElement>(`[${ITEM_ATTRIBUTE}]`)).filter(
    (item) => item.closest(`[${VIEWPORT_ATTRIBUTE}]`) === viewport,
  );
}

/**
 * Clamp height = sum of the `maxVisibleItems` tallest items plus estimated
 * inter-item spacing. Using the tallest items (rather than the first N or a
 * fixed cap) guarantees any single expanded item fits entirely within the
 * viewport, no matter where it sits in the list.
 */
function computeClampHeight(
  items: ReadonlyArray<HTMLElement>,
  maxVisibleItems: number,
): number | null {
  if (items.length <= maxVisibleItems) {
    return null;
  }
  const heights = items.map((item) => item.getBoundingClientRect().height);
  const totalItemHeight = heights.reduce((sum, height) => sum + height, 0);
  const spanTop = items[0]!.getBoundingClientRect().top;
  const spanBottom = items[items.length - 1]!.getBoundingClientRect().bottom;
  const gap = Math.max(0, (spanBottom - spanTop - totalItemHeight) / (items.length - 1));
  const tallest = heights
    .toSorted((a, b) => b - a)
    .slice(0, maxVisibleItems)
    .reduce((sum, height) => sum + height, 0);
  if (tallest <= 0) {
    // Layout has not produced measurable items (e.g. hidden or non-rendered
    // environments) — leave the viewport unclamped rather than collapse it.
    return null;
  }
  return Math.ceil(tallest + gap * (maxVisibleItems - 1));
}
