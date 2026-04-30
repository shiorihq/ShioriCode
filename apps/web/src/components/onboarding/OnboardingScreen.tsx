import { AnimatePresence, LazyMotion, domAnimation, m, useReducedMotion } from "framer-motion";
import type { OnboardingState, OnboardingStepId } from "contracts";

import { LoadingText } from "../ui/loading-text";
import { OnboardingStepIndicator } from "./OnboardingStepIndicator";
import { ConnectProviderStep } from "./ConnectProviderStep";
import { LaunchStep } from "./LaunchStep";

const EASE = [0.4, 0, 0.2, 1] as const;

type OnboardingScreenProps = {
  onboardingState: OnboardingState;
  pendingStepId: OnboardingStepId | null;
  onboardingError: string | null;
  onCompleteStep: (stepId: OnboardingStepId) => Promise<OnboardingState | null>;
  onStartCoding: () => Promise<void>;
};

export function OnboardingScreen({
  onboardingState,
  pendingStepId,
  onboardingError,
  onCompleteStep,
  onStartCoding,
}: OnboardingScreenProps) {
  const shouldReduceMotion = useReducedMotion();
  const skip = !!shouldReduceMotion;
  const currentStepId = onboardingState.currentStepId;

  return (
    <LazyMotion features={domAnimation}>
      <div className="fixed inset-0 flex flex-col overflow-hidden bg-background text-foreground">
        {/* ── Background layers ── */}
        {/* Fine grid overlay */}
        <div
          className="absolute inset-0 opacity-[0.015]"
          style={{
            backgroundImage:
              "linear-gradient(rgba(128,128,128,0.4) 1px, transparent 1px), linear-gradient(90deg, rgba(128,128,128,0.4) 1px, transparent 1px)",
            backgroundSize: "48px 48px",
          }}
        />
        {/* Animated orbs */}
        <div className="onboarding-orb onboarding-orb-1" />
        <div className="onboarding-orb onboarding-orb-2" />

        {/* Corner accents */}
        <div className="absolute top-8 left-8 size-5 border-l border-t border-foreground/[0.04]" />
        <div className="absolute right-8 bottom-8 size-5 border-r border-b border-foreground/[0.04]" />

        {/* ── Content ── */}
        <div className="relative z-10 flex flex-1 flex-col items-center justify-center px-6 py-10">
          {/* Step indicator */}
          <OnboardingStepIndicator onboardingState={onboardingState} />

          {/* Step content */}
          <div className="mt-8 w-full max-w-[560px]">
            <AnimatePresence mode="wait">
              {currentStepId === "connect-provider" ? (
                <m.div
                  key="connect-provider"
                  initial={skip ? false : { opacity: 0, x: 20 }}
                  animate={{ opacity: 1, x: 0 }}
                  exit={{ opacity: 0, x: -20 }}
                  transition={{ duration: 0.35, ease: EASE }}
                >
                  <ConnectProviderStep
                    pendingStepId={pendingStepId}
                    onCompleteStep={onCompleteStep}
                  />
                </m.div>
              ) : currentStepId === "start-first-thread" ? (
                <m.div
                  key="start-first-thread"
                  initial={skip ? false : { opacity: 0, x: 20 }}
                  animate={{ opacity: 1, x: 0 }}
                  exit={{ opacity: 0, scale: 0.98 }}
                  transition={{ duration: 0.35, ease: EASE }}
                >
                  <LaunchStep pendingStepId={pendingStepId} onStartCoding={onStartCoding} />
                </m.div>
              ) : (
                /* sign-in step auto-completes — show a brief loading state */
                <m.div
                  key="sign-in"
                  initial={skip ? false : { opacity: 0 }}
                  animate={{ opacity: 1 }}
                  exit={{ opacity: 0 }}
                  transition={{ duration: 0.2, ease: EASE }}
                  className="text-center"
                >
                  <p className="text-sm text-muted-foreground">
                    <LoadingText>Setting up your account...</LoadingText>
                  </p>
                </m.div>
              )}
            </AnimatePresence>
          </div>

          {/* Error display */}
          {onboardingError ? (
            <m.p
              className="mt-4 text-xs text-destructive"
              role="alert"
              initial={skip ? false : { opacity: 0, y: 4 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.2, ease: EASE }}
            >
              {onboardingError}
            </m.p>
          ) : null}
        </div>
      </div>
    </LazyMotion>
  );
}
