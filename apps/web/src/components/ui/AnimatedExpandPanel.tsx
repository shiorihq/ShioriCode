import { useEffect, useRef, useState, type ReactNode, type TransitionEvent } from "react";
import { useReducedMotion } from "framer-motion";

import { cn } from "~/lib/utils";

/** Animates a panel open/close via grid-template-rows transition. */
export function AnimatedExpandPanel({
  animateOnMount = true,
  open,
  children,
  className,
  contentClassName,
  fade = false,
  unmountOnExit = true,
}: {
  animateOnMount?: boolean;
  open: boolean;
  children: ReactNode;
  className?: string;
  contentClassName?: string;
  fade?: boolean;
  unmountOnExit?: boolean;
}) {
  const shouldReduceMotion = useReducedMotion();
  const [isPresent, setIsPresent] = useState(() => open || !unmountOnExit);
  const lastOpenChildrenRef = useRef(children);

  useEffect(() => {
    if (open) {
      lastOpenChildrenRef.current = children;
    }
  }, [children, open]);

  useEffect(() => {
    if (!unmountOnExit) {
      setIsPresent(true);
      return;
    }

    if (open) {
      setIsPresent(true);
      return;
    }

    if (shouldReduceMotion) {
      setIsPresent(false);
    }
  }, [open, shouldReduceMotion, unmountOnExit]);

  const handleTransitionEnd = (event: TransitionEvent<HTMLDivElement>) => {
    if (event.target !== event.currentTarget) {
      return;
    }
    if (!unmountOnExit || event.propertyName !== "grid-template-rows" || open) {
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
      data-animate-on-mount={animateOnMount ? undefined : "false"}
      onTransitionEnd={handleTransitionEnd}
      className={cn("shiori-expand-panel grid", className)}
    >
      <div
        aria-hidden={!open}
        inert={!open ? true : undefined}
        className={cn("min-h-0 overflow-hidden", contentClassName)}
      >
        <div className={cn(fade && "shiori-expand-panel-fade")}>
          {open ? children : lastOpenChildrenRef.current}
        </div>
      </div>
    </div>
  );
}
