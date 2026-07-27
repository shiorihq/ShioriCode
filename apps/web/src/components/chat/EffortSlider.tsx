import { memo, useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { cn } from "~/lib/utils";
import { isMaxEffort, orderEffortLevels, type EffortLevel } from "./effortRank";

export type EffortSliderLevel = EffortLevel;

const BURST_PARTICLES = Array.from({ length: 8 }, (_, index) => ({
  id: `effort-burst-${index}`,
  angle: `${45 * index + 22}deg`,
  distance: `${22 + (index % 3) * 8}px`,
  delay: `${(index % 4) * 30}ms`,
}));

/** Half the thumb width; keeps the dragged thumb inside the track. */
const THUMB_EDGE_INSET_PX = 12;

function nearestLevelIndex(track: HTMLElement, clientX: number, total: number): number {
  const rect = track.getBoundingClientRect();
  if (rect.width <= 0 || total <= 0) return 0;
  const ratio = (clientX - rect.left) / rect.width;
  const index = Math.floor(ratio * total);
  return Math.min(Math.max(index, 0), total - 1);
}

function clampedTrackX(track: HTMLElement, clientX: number): number {
  const rect = track.getBoundingClientRect();
  return Math.min(
    Math.max(clientX - rect.left, THUMB_EDGE_INSET_PX),
    rect.width - THUMB_EDGE_INSET_PX,
  );
}

/**
 * Horizontal stepped slider for reasoning effort: one dot per level and a
 * draggable thumb. While dragging, the thumb follows the pointer directly and
 * only previews the level; the change is committed on release so the rest of
 * the UI doesn't re-render per step. Works via pointer drag, dot clicks, and
 * arrow keys. Reaching the highest level gets a short, reduced-motion-safe
 * burst so the exceptional mode feels exceptional without changing behavior.
 */
export const EffortSlider = memo(function EffortSlider(props: {
  levels: ReadonlyArray<EffortSliderLevel>;
  value: string;
  onChange: (value: string) => void;
  onPreviewChange?: (value: string | null) => void;
  disabled?: boolean;
  className?: string;
}) {
  const { value, onChange, onPreviewChange, disabled = false } = props;
  const levels = useMemo(() => orderEffortLevels(props.levels), [props.levels]);
  const trackRef = useRef<HTMLDivElement>(null);
  const [dragX, setDragX] = useState<number | null>(null);
  const [previewIndex, setPreviewIndex] = useState<number | null>(null);
  const [burstKey, setBurstKey] = useState(0);
  const previousValueRef = useRef(value);
  // Refs mirror the drag state so pointerup handlers never act on a stale
  // closure — a fast flick can release before the last move's render commits.
  const draggingRef = useRef(false);
  const previewIndexRef = useRef<number | null>(null);

  const total = levels.length;
  const rawIndex = levels.findIndex((level) => level.value === value);
  const committedIndex = rawIndex === -1 ? 0 : rawIndex;
  const displayIndex = previewIndex ?? committedIndex;
  const maxIndex = total - 1;
  const atMax = total > 1 && displayIndex === maxIndex;
  const isDragging = dragX !== null;

  useEffect(() => {
    if (previousValueRef.current === value) return;
    previousValueRef.current = value;
    if (isMaxEffort(value, levels)) {
      setBurstKey((key) => key + 1);
    }
  }, [levels, value]);

  const commitIndex = useCallback(
    (index: number) => {
      const level = levels[index];
      if (level && level.value !== value) {
        onChange(level.value);
      }
      previewIndexRef.current = null;
      setPreviewIndex(null);
      onPreviewChange?.(null);
    },
    [levels, onChange, onPreviewChange, value],
  );

  const previewIndexAt = useCallback(
    (index: number) => {
      previewIndexRef.current = index;
      setPreviewIndex(index);
      onPreviewChange?.(levels[index]?.value ?? null);
    },
    [levels, onPreviewChange],
  );

  const handlePointerDown = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      if (disabled || event.button !== 0) return;
      const track = trackRef.current;
      if (!track) return;
      event.preventDefault();
      track.setPointerCapture(event.pointerId);
      draggingRef.current = true;
      setDragX(clampedTrackX(track, event.clientX));
      previewIndexAt(nearestLevelIndex(track, event.clientX, total));
    },
    [disabled, previewIndexAt, total],
  );

  const handlePointerMove = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      if (disabled || !draggingRef.current) return;
      const track = trackRef.current;
      if (!track) return;
      setDragX(clampedTrackX(track, event.clientX));
      previewIndexAt(nearestLevelIndex(track, event.clientX, total));
    },
    [disabled, previewIndexAt, total],
  );

  // Snap to the level nearest the release point — computed from the pointerup
  // coordinates themselves, so the commit can't lag behind the last render.
  const handlePointerUp = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      if (!draggingRef.current) return;
      draggingRef.current = false;
      setDragX(null);
      const track = trackRef.current;
      const index = track
        ? nearestLevelIndex(track, event.clientX, total)
        : previewIndexRef.current;
      if (index !== null) commitIndex(index);
    },
    [commitIndex, total],
  );

  const handlePointerCancel = useCallback(() => {
    if (!draggingRef.current) return;
    draggingRef.current = false;
    setDragX(null);
    if (previewIndexRef.current !== null) {
      commitIndex(previewIndexRef.current);
    }
  }, [commitIndex]);

  const handleKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLDivElement>) => {
      // Keep arrow keys and typeahead away from an enclosing Base UI menu.
      event.stopPropagation();
      if (disabled) return;
      let nextIndex: number | null = null;
      if (event.key === "ArrowRight" || event.key === "ArrowUp") {
        nextIndex = Math.min(displayIndex + 1, maxIndex);
      } else if (event.key === "ArrowLeft" || event.key === "ArrowDown") {
        nextIndex = Math.max(displayIndex - 1, 0);
      } else if (event.key === "Home") {
        nextIndex = 0;
      } else if (event.key === "End") {
        nextIndex = maxIndex;
      }
      if (nextIndex === null) return;
      event.preventDefault();
      commitIndex(nextIndex);
    },
    [commitIndex, disabled, displayIndex, maxIndex],
  );

  if (total === 0) return null;

  const restingLeft = `${((displayIndex + 0.5) / total) * 100}%`;
  const thumbLeft = dragX !== null ? `${dragX}px` : restingLeft;

  return (
    <div
      ref={trackRef}
      role="radiogroup"
      aria-label="Reasoning effort"
      data-chat-effort-slider="true"
      className={cn(
        "relative h-8 w-full touch-none select-none rounded-full bg-black/6 dark:bg-white/6",
        disabled && "pointer-events-none opacity-55",
        props.className,
      )}
      onKeyDown={handleKeyDown}
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={handlePointerUp}
      onPointerCancel={handlePointerCancel}
    >
      {/* Level dots (each an invisible-hit-area radio button) */}
      {levels.map((level, index) => {
        const isMaxDot = total > 1 && index === maxIndex;
        const isSelected = index === displayIndex;
        return (
          <button
            key={level.value}
            type="button"
            role="radio"
            aria-checked={isSelected}
            aria-label={level.isDefault ? `${level.label} (default)` : level.label}
            title={level.isDefault ? `${level.label} (default)` : level.label}
            tabIndex={isSelected ? 0 : -1}
            disabled={disabled}
            className="group/effort-dot absolute inset-y-0 flex cursor-pointer items-center justify-center outline-none"
            style={{
              left: `${(index / total) * 100}%`,
              width: `${100 / total}%`,
            }}
            onClick={() => commitIndex(index)}
          >
            <span
              aria-hidden="true"
              className={cn(
                "size-1.5 rounded-full transition-colors duration-150",
                isMaxDot
                  ? "bg-violet-500/70 dark:bg-violet-400"
                  : index <= displayIndex
                    ? "bg-black/40 dark:bg-white/45"
                    : "bg-black/22 dark:bg-white/22",
                "group-focus-visible/effort-dot:ring-2 group-focus-visible/effort-dot:ring-ring group-focus-visible/effort-dot:ring-offset-1 group-focus-visible/effort-dot:ring-offset-background",
              )}
            />
          </button>
        );
      })}
      {/* Thumb */}
      <div
        aria-hidden="true"
        className={cn(
          "pointer-events-none absolute top-1/2 h-6 w-5 -translate-x-1/2 -translate-y-1/2 rounded-[8px] border",
          isDragging
            ? "scale-y-110 transition-[background-color,border-color,box-shadow,scale] duration-150"
            : "transition-[left,background-color,border-color,box-shadow,scale] duration-300 ease-[cubic-bezier(0.22,1,0.36,1)]",
          atMax
            ? "border-violet-400/50 bg-violet-500 shadow-[0_1px_4px_--theme(--color-violet-500/45%)] ring-[3px] ring-violet-500/15 dark:bg-violet-400 dark:ring-violet-400/20"
            : "border-black/10 bg-white shadow-[0_1px_4px_--theme(--color-black/25%)] dark:border-white/10 dark:bg-zinc-200",
        )}
        style={{ left: thumbLeft }}
      >
        {atMax && burstKey > 0 ? (
          <span key={burstKey} aria-hidden="true" className="absolute inset-0">
            {BURST_PARTICLES.map((particle) => (
              <span
                key={particle.id}
                className="effort-burst-particle"
                style={
                  {
                    "--burst-angle": particle.angle,
                    "--burst-distance": particle.distance,
                    animationDelay: particle.delay,
                  } as CSSProperties
                }
              />
            ))}
          </span>
        ) : null}
      </div>
    </div>
  );
});

/**
 * The full effort panel: Faster/Smarter caption row and the slider. Used
 * inside the model picker menu, the traits menu, and the standalone effort
 * popover.
 */
export const EffortSliderPanel = memo(function EffortSliderPanel(props: {
  levels: ReadonlyArray<EffortSliderLevel>;
  value: string;
  onChange: (value: string) => void;
  disabled?: boolean;
  note?: string | null;
  className?: string;
}) {
  return (
    <div
      data-chat-effort-slider-panel="true"
      className={cn("flex w-60 flex-col gap-1.5 px-2 py-1.5", props.className)}
      // Keep typed characters from triggering menu typeahead while the
      // panel has focus.
      onKeyDown={(event) => event.stopPropagation()}
    >
      {props.note ? <div className="text-muted-foreground/80 text-xs">{props.note}</div> : null}
      <div className="flex items-center justify-between text-muted-foreground/70 text-xs">
        <span>Faster</span>
        <span>Smarter</span>
      </div>
      <EffortSlider
        levels={props.levels}
        value={props.value}
        onChange={props.onChange}
        disabled={props.disabled ?? false}
      />
    </div>
  );
});
