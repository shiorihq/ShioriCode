import { LazyMotion, domAnimation, m, useReducedMotion } from "framer-motion";

import type { OnboardingState } from "contracts";

import { cn } from "~/lib/utils";

const EASE = [0.4, 0, 0.2, 1] as const;

type OnboardingStepIndicatorProps = {
  onboardingState: OnboardingState;
};

export function OnboardingStepIndicator({ onboardingState }: OnboardingStepIndicatorProps) {
  const shouldReduceMotion = useReducedMotion();
  const skip = !!shouldReduceMotion;

  return (
    <LazyMotion features={domAnimation}>
      <m.div
        className="mt-4 flex items-center gap-2"
        initial={skip ? false : { opacity: 0 }}
        animate={{ opacity: 1 }}
        transition={{ duration: 0.4, delay: 0.1, ease: EASE }}
        role="progressbar"
        aria-valuenow={onboardingState.completedCount}
        aria-valuemin={0}
        aria-valuemax={onboardingState.totalSteps}
        aria-label={`Onboarding progress: ${onboardingState.completedCount} of ${onboardingState.totalSteps} steps complete`}
      >
        {onboardingState.steps.map((step) => {
          const isCurrent = onboardingState.currentStepId === step.id;
          const isCompleted = step.completed;

          return (
            <div key={step.id} className="relative flex items-center justify-center">
              <div
                className={cn(
                  "size-1.5 rounded-full transition-colors duration-300",
                  isCompleted || isCurrent ? "bg-primary" : "bg-border",
                )}
              />
              {isCurrent ? (
                <m.div
                  layoutId="onboarding-step-glow"
                  className="absolute inset-0 size-1.5 rounded-full bg-primary shadow-[0_0_6px_oklch(0.771_0.101_241.4/50%)]"
                  transition={{ type: "spring", stiffness: 300, damping: 25 }}
                />
              ) : null}
            </div>
          );
        })}
      </m.div>
    </LazyMotion>
  );
}
