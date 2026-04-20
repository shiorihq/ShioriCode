"use client";

import { useCallback, useEffect, useRef, useState, type RefCallback, type UIEvent } from "react";

interface UseScrollFadeOverlaysOptions {
  minThreshold?: number;
  thresholdRatio?: number;
  maxStepPerFrame?: number;
  epsilon?: number;
}

export function useScrollFadeOverlays(options: UseScrollFadeOverlaysOptions = {}) {
  const {
    epsilon = 0.005,
    maxStepPerFrame = 0.045,
    minThreshold = 120,
    thresholdRatio = 0.35,
  } = options;
  const [topFadeStrength, setTopFadeStrength] = useState(0);
  const [bottomFadeStrength, setBottomFadeStrength] = useState(0);
  const targetTopRef = useRef(0);
  const targetBottomRef = useRef(0);
  const topRef = useRef(0);
  const bottomRef = useRef(0);
  const rafRef = useRef<number | null>(null);

  const step = useCallback(() => {
    const topDelta = targetTopRef.current - topRef.current;
    const bottomDelta = targetBottomRef.current - bottomRef.current;
    const nextTop =
      topRef.current + Math.sign(topDelta) * Math.min(Math.abs(topDelta), maxStepPerFrame);
    const nextBottom =
      bottomRef.current + Math.sign(bottomDelta) * Math.min(Math.abs(bottomDelta), maxStepPerFrame);

    topRef.current = nextTop;
    bottomRef.current = nextBottom;
    setTopFadeStrength(nextTop);
    setBottomFadeStrength(nextBottom);

    if (
      Math.abs(targetTopRef.current - nextTop) > epsilon ||
      Math.abs(targetBottomRef.current - nextBottom) > epsilon
    ) {
      rafRef.current = requestAnimationFrame(step);
      return;
    }

    topRef.current = targetTopRef.current;
    bottomRef.current = targetBottomRef.current;
    setTopFadeStrength(targetTopRef.current);
    setBottomFadeStrength(targetBottomRef.current);
    rafRef.current = null;
  }, [epsilon, maxStepPerFrame]);

  const scheduleStep = useCallback(() => {
    if (rafRef.current !== null) return;
    rafRef.current = requestAnimationFrame(step);
  }, [step]);

  const update = useCallback(
    (el: HTMLElement) => {
      const threshold = Math.max(minThreshold, Math.round(el.clientHeight * thresholdRatio));
      const distanceFromTop = el.scrollTop;
      const distanceFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
      const toStrength = (distance: number) => Math.max(0, Math.min(1, distance / threshold));

      targetTopRef.current = toStrength(distanceFromTop);
      targetBottomRef.current = toStrength(distanceFromBottom);
      scheduleStep();
    },
    [minThreshold, scheduleStep, thresholdRatio],
  );

  const ref: RefCallback<HTMLDivElement> = useCallback(
    (node) => {
      if (node) {
        update(node);
      }
    },
    [update],
  );

  const onScroll = useCallback(
    (event: UIEvent<HTMLDivElement>) => {
      update(event.currentTarget);
    },
    [update],
  );

  useEffect(
    () => () => {
      if (rafRef.current !== null) {
        cancelAnimationFrame(rafRef.current);
      }
    },
    [],
  );

  return { bottomFadeStrength, onScroll, ref, topFadeStrength, update };
}
