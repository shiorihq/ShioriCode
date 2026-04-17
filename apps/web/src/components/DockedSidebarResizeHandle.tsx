import type { PointerEventHandler } from "react";

interface DockedSidebarResizeHandleProps {
  ariaLabel: string;
  onPointerCancel: PointerEventHandler<HTMLButtonElement>;
  onPointerDown: PointerEventHandler<HTMLButtonElement>;
  onPointerMove: PointerEventHandler<HTMLButtonElement>;
  onPointerUp: PointerEventHandler<HTMLButtonElement>;
}

export function DockedSidebarResizeHandle({
  ariaLabel,
  onPointerCancel,
  onPointerDown,
  onPointerMove,
  onPointerUp,
}: DockedSidebarResizeHandleProps) {
  return (
    <button
      type="button"
      aria-label={ariaLabel}
      className="group absolute inset-y-0 left-0 z-20 hidden w-3 -translate-x-1/2 cursor-col-resize md:flex"
      onPointerCancel={onPointerCancel}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
    >
      <span className="ml-auto h-full w-px bg-border/70 opacity-0 transition-[opacity,background-color] duration-150 group-hover:opacity-100 group-focus-visible:opacity-100 group-active:opacity-100 group-hover:bg-foreground/20 group-focus-visible:bg-foreground/20 group-active:bg-foreground/20" />
    </button>
  );
}
