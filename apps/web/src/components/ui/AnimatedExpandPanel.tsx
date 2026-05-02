import { useEffect, useState, type ReactNode, type TransitionEvent } from "react";
import { useReducedMotion } from "framer-motion";

import { cn } from "~/lib/utils";

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

  useEffect(() => {
    if (open) {
      setIsPresent(true);
      return;
    }

    if (shouldReduceMotion) {
      setIsPresent(false);
    }
  }, [open, shouldReduceMotion]);

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
      className={cn("shiori-expand-panel grid", className)}
    >
      <div
        aria-hidden={!open}
        inert={!open ? true : undefined}
        className={cn("min-h-0 overflow-hidden", contentClassName)}
      >
        <div className={cn(fade && "shiori-expand-panel-fade")}>{children}</div>
      </div>
    </div>
  );
}
