/**
 * Generic recursive renderer for a pane layout tree. Content-agnostic: panes
 * are rendered through `renderPane`, splits become flex rows/columns with
 * draggable (and keyboard-operable) dividers. Sizes are fractions persisted
 * per split via sizes.ts; the layout structure itself is owned by the caller.
 */

import {
  Fragment,
  useCallback,
  useEffect,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from "react";

import { firstPaneKey, type PaneLayoutNode, type SplitDirection, type SplitNode } from "./model";
import {
  applyResizeDelta,
  equalSizes,
  readStoredSplitSizes,
  splitSizesKey,
  writeStoredSplitSizes,
} from "./sizes";
import { cn } from "../lib/utils";

const DEFAULT_MIN_PANE_SIZE_PX = 240;
const KEYBOARD_RESIZE_STEP_FRACTION = 0.02;

export interface SplitLayoutProps {
  layout: PaneLayoutNode;
  minPaneSizePx?: number;
  renderPane: (paneKey: string) => ReactNode;
}

export function SplitLayout(props: SplitLayoutProps) {
  return (
    <div className="flex min-h-0 min-w-0 flex-1 overflow-hidden">
      <LayoutNodeView
        node={props.layout}
        renderPane={props.renderPane}
        minPaneSizePx={props.minPaneSizePx ?? DEFAULT_MIN_PANE_SIZE_PX}
      />
    </div>
  );
}

interface LayoutNodeViewProps {
  minPaneSizePx: number;
  node: PaneLayoutNode;
  renderPane: (paneKey: string) => ReactNode;
}

function LayoutNodeView(props: LayoutNodeViewProps) {
  if (props.node.type === "pane") {
    return <>{props.renderPane(props.node.key)}</>;
  }
  return (
    <SplitView
      node={props.node}
      renderPane={props.renderPane}
      minPaneSizePx={props.minPaneSizePx}
    />
  );
}

interface ResizeState {
  containerSizePx: number;
  dividerIndex: number;
  pointerId: number;
  startCoord: number;
  startSizes: number[];
}

function SplitView(props: {
  minPaneSizePx: number;
  node: SplitNode;
  renderPane: (paneKey: string) => ReactNode;
}) {
  const { minPaneSizePx, node, renderPane } = props;
  const isRow = node.direction === "row";
  const childCount = node.children.length;
  const sizesKey = splitSizesKey(node);

  const containerRef = useRef<HTMLDivElement | null>(null);
  const resizeStateRef = useRef<ResizeState | null>(null);
  const [sizes, setSizes] = useState<number[]>(() => readStoredSplitSizes(sizesKey, childCount));
  const sizesRef = useRef(sizes);
  sizesRef.current = sizes;

  // Reload sizes when this split's identity changes (panes added/removed/moved).
  const appliedSizesKeyRef = useRef(sizesKey);
  if (appliedSizesKeyRef.current !== sizesKey) {
    appliedSizesKeyRef.current = sizesKey;
    const nextSizes = readStoredSplitSizes(sizesKey, childCount);
    sizesRef.current = nextSizes;
    setSizes(nextSizes);
  }

  const minFractionFor = useCallback(
    (containerSizePx: number) =>
      containerSizePx > 0
        ? Math.min(minPaneSizePx / containerSizePx, 1 / childCount)
        : 1 / childCount,
    [childCount, minPaneSizePx],
  );

  const stopResize = useCallback(() => {
    resizeStateRef.current = null;
    document.body.style.removeProperty("cursor");
    document.body.style.removeProperty("user-select");
  }, []);

  useEffect(() => () => stopResize(), [stopResize]);

  const handleResizeStart =
    (dividerIndex: number) => (event: ReactPointerEvent<HTMLButtonElement>) => {
      if (event.button !== 0 || !containerRef.current) {
        return;
      }
      const rect = containerRef.current.getBoundingClientRect();
      resizeStateRef.current = {
        containerSizePx: isRow ? rect.width : rect.height,
        dividerIndex,
        pointerId: event.pointerId,
        startCoord: isRow ? event.clientX : event.clientY,
        startSizes: sizesRef.current,
      };
      event.preventDefault();
      event.currentTarget.setPointerCapture(event.pointerId);
      document.body.style.cursor = isRow ? "col-resize" : "row-resize";
      document.body.style.userSelect = "none";
    };

  const handleResizeMove = (event: ReactPointerEvent<HTMLButtonElement>) => {
    const resizeState = resizeStateRef.current;
    if (!resizeState || resizeState.pointerId !== event.pointerId) {
      return;
    }
    const coord = isRow ? event.clientX : event.clientY;
    const deltaFraction =
      resizeState.containerSizePx > 0
        ? (coord - resizeState.startCoord) / resizeState.containerSizePx
        : 0;
    setSizes(
      applyResizeDelta(
        resizeState.startSizes,
        resizeState.dividerIndex,
        deltaFraction,
        minFractionFor(resizeState.containerSizePx),
      ),
    );
    event.preventDefault();
  };

  const handleResizeEnd = (event: ReactPointerEvent<HTMLButtonElement>) => {
    const resizeState = resizeStateRef.current;
    if (!resizeState || resizeState.pointerId !== event.pointerId) {
      return;
    }
    writeStoredSplitSizes(sizesKey, sizesRef.current);
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    stopResize();
    event.preventDefault();
  };

  const applyAndPersistSizes = (nextSizes: number[]) => {
    sizesRef.current = nextSizes;
    setSizes(nextSizes);
    writeStoredSplitSizes(sizesKey, nextSizes);
  };

  const handleResizeKeyDown =
    (dividerIndex: number) => (event: ReactKeyboardEvent<HTMLButtonElement>) => {
      const decreaseKey = isRow ? "ArrowLeft" : "ArrowUp";
      const increaseKey = isRow ? "ArrowRight" : "ArrowDown";
      const deltaFraction =
        event.key === decreaseKey
          ? -KEYBOARD_RESIZE_STEP_FRACTION
          : event.key === increaseKey
            ? KEYBOARD_RESIZE_STEP_FRACTION
            : null;
      if (deltaFraction === null) {
        return;
      }
      event.preventDefault();
      const rect = containerRef.current?.getBoundingClientRect();
      const containerSizePx = rect ? (isRow ? rect.width : rect.height) : 0;
      applyAndPersistSizes(
        applyResizeDelta(
          sizesRef.current,
          dividerIndex,
          deltaFraction,
          minFractionFor(containerSizePx),
        ),
      );
    };

  const handleResizeReset = () => {
    applyAndPersistSizes(equalSizes(childCount));
  };

  return (
    <div
      ref={containerRef}
      className={cn("flex min-h-0 min-w-0 flex-1 overflow-hidden", isRow ? "flex-row" : "flex-col")}
    >
      {node.children.map((child, index) => (
        <Fragment key={firstPaneKey(child) || `pane-${index}`}>
          {index > 0 ? (
            <SplitResizeHandle
              direction={node.direction}
              onDoubleClick={handleResizeReset}
              onKeyDown={handleResizeKeyDown(index - 1)}
              onPointerCancel={handleResizeEnd}
              onPointerDown={handleResizeStart(index - 1)}
              onPointerMove={handleResizeMove}
              onPointerUp={handleResizeEnd}
            />
          ) : null}
          <div
            className="flex min-h-0 min-w-0 overflow-hidden"
            style={{ flexGrow: sizes[index] ?? 1, flexShrink: 1, flexBasis: 0 }}
          >
            <LayoutNodeView node={child} renderPane={renderPane} minPaneSizePx={minPaneSizePx} />
          </div>
        </Fragment>
      ))}
    </div>
  );
}

function SplitResizeHandle(props: {
  direction: SplitDirection;
  onDoubleClick: () => void;
  onKeyDown: (event: ReactKeyboardEvent<HTMLButtonElement>) => void;
  onPointerCancel: (event: ReactPointerEvent<HTMLButtonElement>) => void;
  onPointerDown: (event: ReactPointerEvent<HTMLButtonElement>) => void;
  onPointerMove: (event: ReactPointerEvent<HTMLButtonElement>) => void;
  onPointerUp: (event: ReactPointerEvent<HTMLButtonElement>) => void;
}) {
  const isRow = props.direction === "row";
  return (
    <button
      type="button"
      aria-label={isRow ? "Resize panes (drag left or right)" : "Resize panes (drag up or down)"}
      title="Drag to resize, double-click to reset"
      className={cn(
        "group relative z-10 flex shrink-0 touch-none items-center justify-center focus-visible:outline-hidden",
        isRow ? "-mx-[3px] w-[7px] cursor-col-resize" : "-my-[3px] h-[7px] cursor-row-resize",
      )}
      onDoubleClick={props.onDoubleClick}
      onKeyDown={props.onKeyDown}
      onPointerCancel={props.onPointerCancel}
      onPointerDown={props.onPointerDown}
      onPointerMove={props.onPointerMove}
      onPointerUp={props.onPointerUp}
    >
      <span
        className={cn(
          "bg-border/70 transition-colors group-hover:bg-foreground/25 group-focus-visible:bg-foreground/25 group-active:bg-foreground/30",
          isRow ? "h-full w-px" : "h-px w-full",
        )}
      />
    </button>
  );
}
