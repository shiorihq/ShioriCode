"use client";

import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  type ComponentProps,
  type UIEvent,
} from "react";

import { cn } from "~/lib/utils";

import { useScrollFadeOverlays } from "./useScrollFadeOverlays";

interface MaskedScrollViewportProps extends ComponentProps<"div"> {
  dependencyKey?: number | string;
  fadeDistance?: string;
  open?: boolean;
}

export function MaskedScrollViewport({
  children,
  className,
  dependencyKey,
  fadeDistance = "3rem",
  onScroll,
  open = true,
  style,
  ...props
}: MaskedScrollViewportProps) {
  const viewportRef = useRef<HTMLDivElement | null>(null);
  const {
    bottomFadeStrength,
    onScroll: onFadeScroll,
    ref: fadeRef,
    topFadeStrength,
    update,
  } = useScrollFadeOverlays();

  const handleRef = useCallback(
    (node: HTMLDivElement | null) => {
      viewportRef.current = node;
      fadeRef(node);
    },
    [fadeRef],
  );

  const handleScroll = useCallback(
    (event: UIEvent<HTMLDivElement>) => {
      onFadeScroll(event);
      onScroll?.(event);
    },
    [onFadeScroll, onScroll],
  );

  useEffect(() => {
    if (!open) {
      return;
    }

    const viewport = viewportRef.current;
    if (!viewport) {
      return;
    }

    update(viewport);

    const resizeObserver = new ResizeObserver(() => {
      update(viewport);
    });
    resizeObserver.observe(viewport);
    const mutationObserver = new MutationObserver(() => {
      update(viewport);
    });
    mutationObserver.observe(viewport, {
      characterData: true,
      childList: true,
      subtree: true,
    });
    return () => {
      resizeObserver.disconnect();
      mutationObserver.disconnect();
    };
  }, [dependencyKey, open, update]);

  useLayoutEffect(() => {
    if (!open) {
      return;
    }

    const viewport = viewportRef.current;
    if (!viewport) {
      return;
    }

    update(viewport);
    const frame = window.requestAnimationFrame(() => {
      update(viewport);
    });
    return () => {
      window.cancelAnimationFrame(frame);
    };
  }, [dependencyKey, open, update]);

  const showTopFade = topFadeStrength > 0.01;
  const showBottomFade = bottomFadeStrength > 0.01;
  const maskImage = `linear-gradient(to bottom, ${
    showTopFade ? `transparent 0%, black ${fadeDistance}` : "black 0%"
  }, ${showBottomFade ? `black calc(100% - ${fadeDistance}), transparent 100%` : "black 100%"})`;

  return (
    <div
      ref={handleRef}
      className={cn(
        "[-ms-overflow-style:none] [scrollbar-width:none] [&::-webkit-scrollbar]:hidden",
        className,
      )}
      style={{
        ...style,
        WebkitMaskImage: maskImage,
        maskImage,
      }}
      onScroll={handleScroll}
      {...props}
    >
      {children}
    </div>
  );
}
