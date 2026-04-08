import { useEffect, useRef } from "react";
import { cn } from "~/lib/utils";

const BRAILLE_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
const FRAME_INTERVAL_MS = 80;

function currentFrame(): string {
  return BRAILLE_FRAMES[Math.floor(Date.now() / FRAME_INTERVAL_MS) % BRAILLE_FRAMES.length];
}

interface BrailleLoaderProps {
  className?: string;
}

export function BrailleLoader({ className }: BrailleLoaderProps) {
  const ref = useRef<HTMLSpanElement>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.textContent = currentFrame();
    const id = setInterval(() => {
      el.textContent = currentFrame();
    }, FRAME_INTERVAL_MS);
    return () => clearInterval(id);
  }, []);

  return (
    <span ref={ref} className={cn("inline-block w-[1ch]", className)} aria-label="Loading" role="status" />
  );
}
