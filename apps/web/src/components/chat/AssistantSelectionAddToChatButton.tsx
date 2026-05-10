import { MessageCircleIcon } from "lucide-react";
import {
  memo,
  useCallback,
  useEffect,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
  type RefObject,
} from "react";
import { createPortal } from "react-dom";
import { cn } from "~/lib/utils";
import { Button } from "../ui/button";

const ASSISTANT_TEXT_SELECTOR = ".assistant-text-selectable";
const OVERLAY_EDGE_PADDING_PX = 92;

interface AssistantSelectionOverlayState {
  selectedText: string;
  left: number;
  top: number;
  placement: "above" | "below";
}

interface AssistantSelectionAddToChatButtonProps {
  containerRef: RefObject<HTMLElement | null>;
  onAddSelectedText: (selectedText: string) => void;
}

interface AssistantSelectionAddToChatControlProps {
  onPointerDown: (event: ReactPointerEvent<HTMLButtonElement>) => void;
  onClick: () => void;
}

function clampToViewportX(value: number): number {
  const viewportWidth = window.innerWidth || document.documentElement.clientWidth;
  if (viewportWidth <= OVERLAY_EDGE_PADDING_PX * 2) {
    return value;
  }
  return Math.min(
    Math.max(value, OVERLAY_EDGE_PADDING_PX),
    viewportWidth - OVERLAY_EDGE_PADDING_PX,
  );
}

function elementFromNode(node: Node | null): Element | null {
  if (!node) return null;
  return node.nodeType === Node.ELEMENT_NODE ? (node as Element) : node.parentElement;
}

function assistantTextRootForNode(node: Node | null): HTMLElement | null {
  const element = elementFromNode(node);
  return element?.closest<HTMLElement>(ASSISTANT_TEXT_SELECTOR) ?? null;
}

function firstVisibleSelectionRect(range: Range): DOMRect | null {
  for (const rect of Array.from(range.getClientRects())) {
    if (rect.width > 0 && rect.height > 0) {
      return rect;
    }
  }

  const rect = range.getBoundingClientRect();
  return rect.width > 0 || rect.height > 0 ? rect : null;
}

function readAssistantSelectionOverlayState(
  container: HTMLElement | null,
): AssistantSelectionOverlayState | null {
  const selection = window.getSelection();
  if (!selection || selection.isCollapsed || selection.rangeCount === 0) {
    return null;
  }

  const selectedText = selection.toString().trim();
  if (selectedText.length === 0) {
    return null;
  }

  const anchorRoot = assistantTextRootForNode(selection.anchorNode);
  const focusRoot = assistantTextRootForNode(selection.focusNode);
  if (!anchorRoot || anchorRoot !== focusRoot) {
    return null;
  }
  if (container && !container.contains(anchorRoot)) {
    return null;
  }

  const range = selection.getRangeAt(0);
  if (!anchorRoot.contains(range.startContainer) || !anchorRoot.contains(range.endContainer)) {
    return null;
  }

  const rect = firstVisibleSelectionRect(range);
  if (!rect) {
    return null;
  }

  const placement = rect.top >= 52 ? "above" : "below";
  return {
    selectedText,
    left: clampToViewportX(rect.left + rect.width / 2),
    top: placement === "above" ? Math.max(8, rect.top - 8) : rect.bottom + 8,
    placement,
  };
}

export const AssistantSelectionAddToChatButton = memo(function AssistantSelectionAddToChatButton({
  containerRef,
  onAddSelectedText,
}: AssistantSelectionAddToChatButtonProps) {
  const [selectionOverlay, setSelectionOverlay] = useState<AssistantSelectionOverlayState | null>(
    null,
  );
  const animationFrameRef = useRef<number | null>(null);

  const updateSelectionOverlay = useCallback(() => {
    const nextOverlay = readAssistantSelectionOverlayState(containerRef.current);
    if (nextOverlay) {
      setSelectionOverlay(nextOverlay);
      return;
    }

    setSelectionOverlay(null);
  }, [containerRef]);

  const scheduleSelectionOverlayUpdate = useCallback(() => {
    if (animationFrameRef.current !== null) {
      return;
    }
    animationFrameRef.current = window.requestAnimationFrame(() => {
      animationFrameRef.current = null;
      updateSelectionOverlay();
    });
  }, [updateSelectionOverlay]);

  useEffect(() => {
    scheduleSelectionOverlayUpdate();
    document.addEventListener("selectionchange", scheduleSelectionOverlayUpdate);
    document.addEventListener("keyup", scheduleSelectionOverlayUpdate);
    document.addEventListener("pointerup", scheduleSelectionOverlayUpdate);
    document.addEventListener("scroll", scheduleSelectionOverlayUpdate, true);
    window.addEventListener("resize", scheduleSelectionOverlayUpdate);
    return () => {
      document.removeEventListener("selectionchange", scheduleSelectionOverlayUpdate);
      document.removeEventListener("keyup", scheduleSelectionOverlayUpdate);
      document.removeEventListener("pointerup", scheduleSelectionOverlayUpdate);
      document.removeEventListener("scroll", scheduleSelectionOverlayUpdate, true);
      window.removeEventListener("resize", scheduleSelectionOverlayUpdate);
      if (animationFrameRef.current !== null) {
        window.cancelAnimationFrame(animationFrameRef.current);
        animationFrameRef.current = null;
      }
    };
  }, [scheduleSelectionOverlayUpdate]);

  const handlePointerDown = useCallback((event: ReactPointerEvent<HTMLButtonElement>) => {
    event.preventDefault();
  }, []);

  const handleAddSelectedText = useCallback(() => {
    const selectedText = selectionOverlay?.selectedText;
    if (!selectedText) {
      return;
    }
    onAddSelectedText(selectedText);
    setSelectionOverlay(null);
    window.getSelection()?.removeAllRanges();
  }, [onAddSelectedText, selectionOverlay?.selectedText]);

  if (!selectionOverlay) {
    return null;
  }

  return createPortal(
    <div
      className="pointer-events-none fixed z-50"
      style={{
        left: selectionOverlay.left,
        top: selectionOverlay.top,
        transform:
          selectionOverlay.placement === "above" ? "translate(-50%, -100%)" : "translate(-50%, 0)",
      }}
    >
      <AssistantSelectionAddToChatControl
        onPointerDown={handlePointerDown}
        onClick={handleAddSelectedText}
      />
    </div>,
    document.body,
  );
});

export function AssistantSelectionAddToChatControl({
  onPointerDown,
  onClick,
}: AssistantSelectionAddToChatControlProps) {
  return (
    <div className="pointer-events-auto rounded-full border border-border/70 bg-popover p-0.5 shadow-md">
      <Button
        type="button"
        variant="ghost"
        size="sm"
        className={cn(
          "h-6 gap-1 rounded-full bg-popover px-2 text-[10px]/3 before:rounded-full",
          "text-popover-foreground hover:bg-accent hover:text-accent-foreground",
        )}
        data-assistant-selection-add-to-chat="true"
        onPointerDown={onPointerDown}
        onClick={onClick}
      >
        <MessageCircleIcon className="size-3" aria-hidden="true" />
        Add to chat
      </Button>
    </div>
  );
}
