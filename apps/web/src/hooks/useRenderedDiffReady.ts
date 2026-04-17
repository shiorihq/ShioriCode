import { type RefObject, useEffect, useState } from "react";

import { hasVisibleDiffContent } from "~/lib/diffVisibility";

interface UseRenderedDiffReadyOptions {
  rootRef: RefObject<HTMLElement | null>;
  enabled: boolean;
  dependencyKey: string | number | boolean | null | undefined;
  timeoutMs?: number;
}

export function useRenderedDiffReady({
  rootRef,
  enabled,
  dependencyKey,
  timeoutMs = 1200,
}: UseRenderedDiffReadyOptions) {
  const [isReady, setIsReady] = useState(false);

  useEffect(() => {
    if (!enabled) {
      setIsReady(false);
      return;
    }

    const root = rootRef.current;
    if (!root || typeof window === "undefined") {
      return;
    }

    let settled = false;
    let observer: MutationObserver | null = null;
    let timeoutId: number | null = null;
    let frameId: number | null = null;

    const settle = () => {
      if (settled) {
        return;
      }
      settled = true;
      setIsReady(true);
      observer?.disconnect();
      if (frameId !== null) {
        window.cancelAnimationFrame(frameId);
      }
      if (timeoutId !== null) {
        window.clearTimeout(timeoutId);
      }
    };

    const markVisibleIfReady = () => {
      if (settled || !hasVisibleDiffContent(root)) {
        return;
      }
      settle();
    };

    const scheduleVisibilityCheck = () => {
      if (frameId !== null) {
        return;
      }
      frameId = window.requestAnimationFrame(() => {
        frameId = null;
        markVisibleIfReady();
      });
    };

    scheduleVisibilityCheck();

    timeoutId = window.setTimeout(() => {
      settle();
    }, timeoutMs);

    if (typeof MutationObserver !== "undefined") {
      observer = new MutationObserver(() => {
        scheduleVisibilityCheck();
      });
      observer.observe(root, {
        childList: true,
        subtree: true,
      });
    }

    return () => {
      if (frameId !== null) {
        window.cancelAnimationFrame(frameId);
      }
      if (timeoutId !== null) {
        window.clearTimeout(timeoutId);
      }
      observer?.disconnect();
    };
  }, [dependencyKey, enabled, rootRef, timeoutMs]);

  return isReady;
}
