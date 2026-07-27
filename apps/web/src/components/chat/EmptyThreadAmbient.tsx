import { useEffect, useRef } from "react";
import { useReducedMotion } from "framer-motion";

import { cn } from "~/lib/utils";

type EmptyThreadAmbientProps = {
  promptLength: number;
};

export function EmptyThreadAmbient({ promptLength }: EmptyThreadAmbientProps) {
  const shouldReduceMotion = useReducedMotion();
  const fadeProgress = Math.min(1, promptLength / 14);
  const opacity = 1 - fadeProgress;
  const visible = opacity > 0.01 && !shouldReduceMotion;
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const element = ref.current;
    const parent = element?.parentElement;
    if (!element || !parent || !visible) return;

    let bounds = element.getBoundingClientRect();
    let pendingPoint: { x: number; y: number } | null = null;
    let frame: number | null = null;

    const flushPointer = () => {
      frame = null;
      if (!pendingPoint) return;
      element.style.setProperty("--mx", `${pendingPoint.x - bounds.left}px`);
      element.style.setProperty("--my", `${pendingPoint.y - bounds.top}px`);
    };
    const schedulePointerFlush = () => {
      if (frame === null) frame = window.requestAnimationFrame(flushPointer);
    };
    const onPointerMove = (event: PointerEvent) => {
      pendingPoint = { x: event.clientX, y: event.clientY };
      schedulePointerFlush();
    };
    const updateBounds = () => {
      bounds = element.getBoundingClientRect();
      schedulePointerFlush();
    };

    parent.addEventListener("pointerenter", updateBounds);
    parent.addEventListener("pointermove", onPointerMove);
    const observer =
      typeof ResizeObserver === "undefined" ? null : new ResizeObserver(updateBounds);
    observer?.observe(parent);
    observer?.observe(element);

    return () => {
      if (frame !== null) window.cancelAnimationFrame(frame);
      observer?.disconnect();
      parent.removeEventListener("pointerenter", updateBounds);
      parent.removeEventListener("pointermove", onPointerMove);
    };
  }, [visible]);

  return (
    <div
      ref={ref}
      aria-hidden="true"
      className={cn(
        "empty-thread-ambient pointer-events-none absolute inset-0 overflow-hidden transition-opacity duration-300 ease-out",
        visible ? "opacity-100" : "opacity-0",
      )}
      style={{ opacity: Number(opacity.toFixed(3)) }}
    >
      <div className="ambient-grid" />
    </div>
  );
}
