import { useCallback } from "react";
import { LazyMotion, domAnimation, m, useReducedMotion } from "framer-motion";
import type { OnboardingStepId } from "contracts";

import { Button } from "../ui/button";
import { ShioriIcon } from "../Icons";

const EASE = [0.4, 0, 0.2, 1] as const;

type LaunchStepProps = {
  pendingStepId: OnboardingStepId | null;
  onStartCoding: () => Promise<void>;
};

export function LaunchStep({ pendingStepId, onStartCoding }: LaunchStepProps) {
  const shouldReduceMotion = useReducedMotion();
  const skip = !!shouldReduceMotion;
  const isLaunching = pendingStepId === "start-first-thread";

  const handleLaunch = useCallback(() => {
    void onStartCoding();
  }, [onStartCoding]);

  return (
    <LazyMotion features={domAnimation}>
      <div className="flex flex-col items-center text-center">
        {/* Icon */}
        <m.div
          className="mb-6 flex size-[72px] items-center justify-center rounded-2xl border border-border/60 bg-card/80 text-primary shadow-sm"
          initial={skip ? false : { opacity: 0, scale: 0.8 }}
          animate={{ opacity: 1, scale: 1 }}
          transition={skip ? { duration: 0 } : { type: "spring", stiffness: 200, damping: 20 }}
        >
          <ShioriIcon className="size-9" />
        </m.div>

        {/* Heading */}
        <m.h1
          className="text-[1.75rem] font-bold leading-tight tracking-tight"
          initial={skip ? false : { opacity: 0, y: 8 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.4, delay: 0.15, ease: EASE }}
        >
          You're all set.
        </m.h1>

        {/* Subtitle */}
        <m.p
          className="mt-2 text-[15px] leading-relaxed text-muted-foreground/60"
          initial={skip ? false : { opacity: 0, y: 8 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.4, delay: 0.25, ease: EASE }}
        >
          Open the app and start your first conversation with a coding agent.
        </m.p>

        {/* Divider */}
        <m.div
          className="mx-auto mt-6 h-px w-12 bg-gradient-to-r from-transparent via-border to-transparent"
          initial={skip ? false : { scaleX: 0 }}
          animate={{ scaleX: 1 }}
          transition={{ duration: 0.4, delay: 0.35, ease: EASE }}
        />

        {/* Launch button */}
        <m.div
          className="mt-6 w-full max-w-[280px]"
          initial={skip ? false : { opacity: 0, y: 8 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.35, delay: 0.45, ease: EASE }}
        >
          <Button className="w-full" size="lg" disabled={isLaunching} onClick={handleLaunch}>
            {isLaunching ? "Launching..." : "Start coding"}
          </Button>
        </m.div>
      </div>
    </LazyMotion>
  );
}
