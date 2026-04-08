import { spinners, type BrailleSpinnerName } from "unicode-animations";
import { useEffect, useRef } from "react";
import { cn } from "~/lib/utils";

const DEFAULT_SPINNER_NAME: BrailleSpinnerName = "orbit";
const spinnerNames = Object.keys(spinners) as BrailleSpinnerName[];

export function pickRandomBrailleSpinnerName(): BrailleSpinnerName {
  if (spinnerNames.length === 0) {
    return DEFAULT_SPINNER_NAME;
  }
  const randomIndex = Math.floor(Math.random() * spinnerNames.length);
  return spinnerNames[randomIndex] ?? DEFAULT_SPINNER_NAME;
}

function currentFrame(spinnerName: BrailleSpinnerName): string {
  const spinner = spinners[spinnerName] ?? spinners[DEFAULT_SPINNER_NAME];
  return spinner.frames[Math.floor(Date.now() / spinner.interval) % spinner.frames.length] ?? "⠋";
}

interface BrailleLoaderProps {
  className?: string;
  spinnerName?: BrailleSpinnerName;
}

export function BrailleLoader({
  className,
  spinnerName = DEFAULT_SPINNER_NAME,
}: BrailleLoaderProps) {
  const ref = useRef<HTMLSpanElement>(null);

  useEffect(() => {
    const spinner = spinners[spinnerName] ?? spinners[DEFAULT_SPINNER_NAME];
    const el = ref.current;
    if (!el) return;
    el.textContent = currentFrame(spinnerName);
    const id = setInterval(() => {
      el.textContent = currentFrame(spinnerName);
    }, spinner.interval);
    return () => clearInterval(id);
  }, [spinnerName]);

  return (
    <span ref={ref} className={cn("inline-block", className)} aria-label="Loading" role="status" />
  );
}
