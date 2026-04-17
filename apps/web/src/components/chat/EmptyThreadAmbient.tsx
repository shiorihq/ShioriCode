import { useEffect, useRef } from "react";

import { cn } from "~/lib/utils";

type EmptyThreadAmbientProps = {
  promptLength: number;
};

export function EmptyThreadAmbient({ promptLength }: EmptyThreadAmbientProps) {
  const fadeProgress = Math.min(1, promptLength / 14);
  const opacity = 1 - fadeProgress;
  const ref = useRef<HTMLDivElement>(null);
  const boundsRef = useRef<DOMRect | null>(null);
  const pendingPointRef = useRef<{ x: number; y: number } | null>(null);
  const frameRef = useRef<number | null>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const parent = el.parentElement;
    if (!parent) return;

    const updateBounds = () => {
      boundsRef.current = el.getBoundingClientRect();
    };

    const flushPointer = () => {
      frameRef.current = null;
      const point = pendingPointRef.current;
      const bounds = boundsRef.current;
      if (!point || !bounds) {
        return;
      }
      el.style.setProperty("--mx", `${point.x - bounds.left}px`);
      el.style.setProperty("--my", `${point.y - bounds.top}px`);
    };

    const schedulePointerFlush = () => {
      if (frameRef.current !== null) {
        return;
      }
      frameRef.current = window.requestAnimationFrame(flushPointer);
    };

    const onMove = (event: MouseEvent) => {
      pendingPointRef.current = { x: event.clientX, y: event.clientY };
      schedulePointerFlush();
    };

    const onPointerEnter = () => {
      updateBounds();
      schedulePointerFlush();
    };

    updateBounds();
    parent.addEventListener("pointerenter", onPointerEnter);
    parent.addEventListener("mousemove", onMove);

    let observer: ResizeObserver | null = null;
    if (typeof ResizeObserver !== "undefined") {
      observer = new ResizeObserver(() => {
        updateBounds();
      });
      observer.observe(parent);
      observer.observe(el);
    }

    return () => {
      if (frameRef.current !== null) {
        window.cancelAnimationFrame(frameRef.current);
      }
      observer?.disconnect();
      parent.removeEventListener("pointerenter", onPointerEnter);
      parent.removeEventListener("mousemove", onMove);
    };
  }, []);

  return (
    <div
      ref={ref}
      aria-hidden="true"
      className={cn(
        "empty-thread-ambient pointer-events-none absolute inset-0 overflow-hidden transition-opacity duration-300 ease-out",
        opacity <= 0.01 ? "opacity-0" : "opacity-100",
      )}
      style={{ opacity: Number(opacity.toFixed(3)) }}
    >
      <div className="ambient-grid" />
    </div>
  );
}
