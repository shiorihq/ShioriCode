import { ThreadId } from "contracts";
import { useRef, type DragEvent as ReactDragEvent } from "react";
import { IconXmarkOutline24 as XIcon } from "nucleo-core-outline-24";

import ChatView from "./ChatView";
import { hasThreadPaneDragData, readThreadPaneDragData, resolveDropZone } from "../paneLayout/dnd";
import type { PaneDropZone } from "../paneLayout/model";
import { cn } from "../lib/utils";

export interface ChatThreadPaneProps {
  dropZone: PaneDropZone | null;
  focused: boolean;
  multiPane: boolean;
  onClose: () => void;
  onDropZoneChange: (zone: PaneDropZone | null) => void;
  onFocus: () => void;
  onThreadDrop: (droppedThreadId: ThreadId, zone: PaneDropZone) => void;
  threadId: ThreadId;
}

export function ChatThreadPane(props: ChatThreadPaneProps) {
  const dragDepthRef = useRef(0);

  const handleDragEnter = (event: ReactDragEvent<HTMLElement>) => {
    if (!hasThreadPaneDragData(event.dataTransfer)) {
      return;
    }
    event.preventDefault();
    dragDepthRef.current += 1;
  };

  const handleDragOver = (event: ReactDragEvent<HTMLElement>) => {
    if (!hasThreadPaneDragData(event.dataTransfer)) {
      return;
    }
    event.preventDefault();
    event.dataTransfer.dropEffect = "copy";
    props.onDropZoneChange(
      resolveDropZone(event.currentTarget.getBoundingClientRect(), event.clientX, event.clientY),
    );
  };

  const handleDragLeave = (event: ReactDragEvent<HTMLElement>) => {
    if (!hasThreadPaneDragData(event.dataTransfer)) {
      return;
    }
    dragDepthRef.current = Math.max(0, dragDepthRef.current - 1);
    if (dragDepthRef.current === 0) {
      props.onDropZoneChange(null);
    }
  };

  const handleDrop = (event: ReactDragEvent<HTMLElement>) => {
    dragDepthRef.current = 0;
    const droppedThreadId = readThreadPaneDragData(event.dataTransfer);
    if (!droppedThreadId) {
      props.onDropZoneChange(null);
      return;
    }
    event.preventDefault();
    const zone = resolveDropZone(
      event.currentTarget.getBoundingClientRect(),
      event.clientX,
      event.clientY,
    );
    props.onDropZoneChange(null);
    props.onThreadDrop(droppedThreadId, zone);
  };

  return (
    <section
      aria-label={props.focused ? "Focused thread pane" : "Thread pane"}
      data-focused={props.focused ? "true" : "false"}
      className={cn(
        "relative flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden bg-background",
        props.multiPane && !props.focused && "bg-muted/10",
      )}
      onFocusCapture={() => {
        if (!props.focused) {
          props.onFocus();
        }
      }}
      onPointerDownCapture={(event) => {
        if (props.focused) {
          return;
        }
        const target = event.target;
        if (!(target instanceof Element)) {
          return;
        }
        if (target.closest("[data-thread-pane-close='true']")) {
          return;
        }
        props.onFocus();
      }}
      onDragEnter={handleDragEnter}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
    >
      {props.multiPane ? (
        <div
          className={cn(
            "flex h-8 shrink-0 items-center justify-end border-b px-2",
            props.focused ? "border-foreground/20 bg-background" : "border-border/70 bg-muted/10",
          )}
        >
          <div
            className={cn(
              "pointer-events-none absolute inset-x-0 top-0 z-30 h-px transition-colors",
              props.focused ? "bg-foreground/60" : "bg-border/80",
            )}
          />
          <button
            type="button"
            data-thread-pane-close="true"
            aria-label="Close thread pane"
            className="inline-flex size-6 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-sidebar-hover hover:text-foreground focus-visible:outline-hidden focus-visible:ring-1 focus-visible:ring-ring"
            onClick={(event) => {
              event.preventDefault();
              event.stopPropagation();
              props.onClose();
            }}
          >
            <XIcon className="size-3.5" />
          </button>
        </div>
      ) : null}
      <ChatView key={props.threadId} threadId={props.threadId} isFocusedPane={props.focused} />
      {props.dropZone ? <PaneDropZoneOverlay zone={props.dropZone} /> : null}
    </section>
  );
}

function PaneDropZoneOverlay(props: { zone: PaneDropZone }) {
  return (
    <div className="pointer-events-none absolute inset-0 z-40">
      <div
        className={cn(
          "absolute rounded-md border border-dashed border-foreground/40 bg-foreground/10 transition-[inset]",
          props.zone === "center" && "inset-1.5",
          props.zone === "left" && "inset-y-1.5 left-1.5 right-1/2",
          props.zone === "right" && "inset-y-1.5 left-1/2 right-1.5",
          props.zone === "top" && "inset-x-1.5 top-1.5 bottom-1/2",
          props.zone === "bottom" && "inset-x-1.5 top-1/2 bottom-1.5",
        )}
      />
    </div>
  );
}
