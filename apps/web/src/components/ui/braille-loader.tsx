import { spinners, type BrailleSpinnerName } from "unicode-animations";
import { useSyncExternalStore } from "react";
import { cn } from "~/lib/utils";

const DEFAULT_SPINNER_NAME: BrailleSpinnerName = "orbit";
const spinnerNames = Object.keys(spinners) as BrailleSpinnerName[];
const BRAILLE_TICK_MS = 80;

const brailleTickerListeners = new Set<() => void>();
let brailleTickerId: number | null = null;
let brailleVisibilityListenerAttached = false;
let brailleTickerNow = 0;

export function pickRandomBrailleSpinnerName(): BrailleSpinnerName {
  if (spinnerNames.length === 0) {
    return DEFAULT_SPINNER_NAME;
  }
  const randomIndex = Math.floor(Math.random() * spinnerNames.length);
  return spinnerNames[randomIndex] ?? DEFAULT_SPINNER_NAME;
}

function currentFrame(spinnerName: BrailleSpinnerName, now: number): string {
  const spinner = spinners[spinnerName] ?? spinners[DEFAULT_SPINNER_NAME];
  return spinner.frames[Math.floor(now / spinner.interval) % spinner.frames.length] ?? "⠋";
}

function stopBrailleTicker() {
  if (brailleTickerId === null) {
    return;
  }
  window.clearInterval(brailleTickerId);
  brailleTickerId = null;
}

function emitBrailleTicker() {
  brailleTickerNow = Date.now();
  for (const listener of brailleTickerListeners) {
    listener();
  }
}

function startBrailleTickerIfNeeded() {
  if (typeof window === "undefined") {
    return;
  }
  if (brailleTickerId !== null || brailleTickerListeners.size === 0) {
    return;
  }
  if (typeof document !== "undefined" && document.hidden) {
    return;
  }

  brailleTickerId = window.setInterval(() => {
    emitBrailleTicker();
  }, BRAILLE_TICK_MS);
}

function ensureBrailleTickerVisibilityListener() {
  if (brailleVisibilityListenerAttached || typeof document === "undefined") {
    return;
  }

  document.addEventListener("visibilitychange", () => {
    if (document.hidden) {
      stopBrailleTicker();
      return;
    }

    emitBrailleTicker();
    startBrailleTickerIfNeeded();
  });
  brailleVisibilityListenerAttached = true;
}

function subscribeToBrailleTicker(listener: () => void): () => void {
  if (typeof window === "undefined") {
    return () => undefined;
  }

  ensureBrailleTickerVisibilityListener();
  brailleTickerListeners.add(listener);
  brailleTickerNow = Date.now();
  listener();
  startBrailleTickerIfNeeded();

  return () => {
    brailleTickerListeners.delete(listener);
    if (brailleTickerListeners.size === 0) {
      stopBrailleTicker();
    }
  };
}

function getBrailleTickerSnapshot(): number {
  if (brailleTickerNow === 0) {
    brailleTickerNow = Date.now();
  }
  return brailleTickerNow;
}

function getBrailleTickerServerSnapshot(): number {
  return 0;
}

interface BrailleLoaderProps {
  className?: string;
  spinnerName?: BrailleSpinnerName;
}

export function BrailleLoader({
  className,
  spinnerName = DEFAULT_SPINNER_NAME,
}: BrailleLoaderProps) {
  const now = useSyncExternalStore(
    subscribeToBrailleTicker,
    getBrailleTickerSnapshot,
    getBrailleTickerServerSnapshot,
  );

  return (
    <span className={cn("inline-block", className)} aria-label="Loading" role="status">
      {currentFrame(spinnerName, now)}
    </span>
  );
}
