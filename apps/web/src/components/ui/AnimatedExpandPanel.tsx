import { useEffect, useRef, useState, type ReactNode, type TransitionEvent } from "react";
import { useReducedMotion } from "framer-motion";

import { cn } from "~/lib/utils";

const EXPAND_PANEL_TRANSITION_CLASS =
  "duration-[220ms] ease-[cubic-bezier(0.22,1,0.36,1)] motion-reduce:transition-none";

/** Animates a panel open/close via grid-template-rows transition. */
export function AnimatedExpandPanel({
  open,
  children,
  className,
  contentClassName,
  fade = false,
}: {
  open: boolean;
  children: ReactNode;
  className?: string;
  contentClassName?: string;
  fade?: boolean;
}) {
  const shouldReduceMotion = useReducedMotion();
  const [isPresent, setIsPresent] = useState(open);
  const [isExpanded, setIsExpanded] = useState(open);
  const enterAnimationFrameRef = useRef<number | null>(null);

  useEffect(() => {
    if (enterAnimationFrameRef.current !== null) {
      window.cancelAnimationFrame(enterAnimationFrameRef.current);
      enterAnimationFrameRef.current = null;
    }

    if (open) {
      if (!isPresent && !shouldReduceMotion) {
        setIsPresent(true);
        setIsExpanded(false);
        enterAnimationFrameRef.current = window.requestAnimationFrame(() => {
          enterAnimationFrameRef.current = window.requestAnimationFrame(() => {
            setIsExpanded(true);
            enterAnimationFrameRef.current = null;
          });
        });
        return;
      }

      setIsPresent(true);
      setIsExpanded(true);
      return;
    }

    setIsExpanded(false);
    if (shouldReduceMotion) {
      setIsPresent(false);
    }
  }, [isPresent, open, shouldReduceMotion]);

  useEffect(() => {
    return () => {
      if (enterAnimationFrameRef.current !== null) {
        window.cancelAnimationFrame(enterAnimationFrameRef.current);
      }
    };
  }, []);

  const handleTransitionEnd = (event: TransitionEvent<HTMLDivElement>) => {
    if (event.target !== event.currentTarget) {
      return;
    }
    if (event.propertyName !== "grid-template-rows" || open) {
      return;
    }
    setIsPresent(false);
  };

  if (!open && !isPresent) {
    return null;
  }

  return (
    <div
      data-state={open ? "open" : "closed"}
      onTransitionEnd={handleTransitionEnd}
      className={cn(
        "grid transition-[grid-template-rows]",
        EXPAND_PANEL_TRANSITION_CLASS,
        isExpanded ? "grid-rows-[1fr]" : "grid-rows-[0fr]",
        className,
      )}
    >
      <div
        aria-hidden={!open}
        inert={!open ? true : undefined}
        className={cn("min-h-0 overflow-hidden", contentClassName)}
      >
        <div
          className={cn(
            fade &&
              cn(
                "transition-[opacity,transform]",
                EXPAND_PANEL_TRANSITION_CLASS,
                isExpanded ? "translate-y-0 opacity-100" : "-translate-y-1 opacity-0",
              ),
          )}
        >
          {children}
        </div>
      </div>
    </div>
  );
}
