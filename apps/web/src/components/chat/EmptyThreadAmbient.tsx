import { useEffect, useRef } from "react";

import { cn } from "~/lib/utils";

type EmptyThreadAmbientProps = {
  promptLength: number;
};

export function EmptyThreadAmbient({ promptLength }: EmptyThreadAmbientProps) {
  const fadeProgress = Math.min(1, promptLength / 14);
  const opacity = 1 - fadeProgress;
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const parent = el.parentElement;
    if (!parent) return;

    function onMove(e: MouseEvent) {
      const rect = el!.getBoundingClientRect();
      el!.style.setProperty("--mx", `${e.clientX - rect.left}px`);
      el!.style.setProperty("--my", `${e.clientY - rect.top}px`);
    }

    parent.addEventListener("mousemove", onMove);
    return () => parent.removeEventListener("mousemove", onMove);
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
