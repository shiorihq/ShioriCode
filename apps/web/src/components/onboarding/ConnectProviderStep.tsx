import { useCallback, useMemo, useState } from "react";
import { LazyMotion, domAnimation, m, useReducedMotion } from "framer-motion";
import type { OnboardingStepId } from "contracts";

import { Button } from "../ui/button";
import { LoadingText } from "../ui/loading-text";
import { ProviderCard } from "./ProviderCard";
import { useServerProviders } from "~/rpc/serverState";
import { useMergedServerProviders } from "~/convex/shioriProvider";
import { useHostedShioriState } from "~/convex/HostedShioriProvider";
import { ensureNativeApi } from "~/nativeApi";
import { setServerConfigSnapshot } from "~/rpc/serverState";

const EASE = [0.4, 0, 0.2, 1] as const;

type ConnectProviderStepProps = {
  pendingStepId: OnboardingStepId | null;
  onCompleteStep: (stepId: OnboardingStepId) => Promise<unknown>;
};

export function ConnectProviderStep({ pendingStepId, onCompleteStep }: ConnectProviderStepProps) {
  const shouldReduceMotion = useReducedMotion();
  const skip = !!shouldReduceMotion;
  const serverProviders = useServerProviders();
  const mergedProviders = useMergedServerProviders(serverProviders);
  const { viewer } = useHostedShioriState();
  const [isRefreshing, setIsRefreshing] = useState(false);

  const hasReadyProvider = useMemo(
    () => mergedProviders.some((p) => p.status === "ready"),
    [mergedProviders],
  );

  const isContinuing = pendingStepId === "connect-provider";

  const handleRefresh = useCallback(async () => {
    setIsRefreshing(true);
    try {
      const config = await ensureNativeApi().server.getConfig();
      setServerConfigSnapshot(config);
    } catch {
      // Status will remain stale until next refresh
    } finally {
      setIsRefreshing(false);
    }
  }, []);

  const handleContinue = useCallback(() => {
    void onCompleteStep("connect-provider");
  }, [onCompleteStep]);

  return (
    <LazyMotion features={domAnimation}>
      <div className="space-y-6">
        {/* Heading */}
        <m.div
          initial={skip ? false : { opacity: 0, y: 8 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.4, ease: EASE }}
        >
          <h1 className="text-[1.75rem] font-bold leading-tight tracking-tight">
            Connect a provider
          </h1>
          <p className="mt-2 text-[15px] leading-relaxed text-muted-foreground">
            ShioriCode works with multiple coding agents.
            <br />
            Connect at least one to continue.
          </p>
        </m.div>

        {/* Provider cards */}
        <div className="space-y-3">
          {mergedProviders.length === 0 ? (
            <m.div
              initial={skip ? false : { opacity: 0 }}
              animate={{ opacity: 1 }}
              className="rounded-xl border border-border/70 bg-background/40 p-4"
            >
              <p className="text-sm text-muted-foreground">
                <LoadingText>Checking provider status...</LoadingText>
              </p>
            </m.div>
          ) : (
            mergedProviders.map((provider, index) => (
              <ProviderCard
                key={provider.provider}
                provider={provider}
                index={index}
                viewerEmail={viewer?.email}
                onRefresh={handleRefresh}
                isRefreshing={isRefreshing}
              />
            ))
          )}
        </div>

        {/* Continue button */}
        <m.div
          initial={skip ? false : { opacity: 0, y: 8 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.35, delay: 0.3, ease: EASE }}
        >
          <Button
            className="w-full"
            size="lg"
            disabled={!hasReadyProvider || isContinuing || pendingStepId === "sign-in"}
            onClick={handleContinue}
          >
            {isContinuing ? "Continuing..." : "Continue"}
          </Button>
          {!hasReadyProvider && mergedProviders.length > 0 ? (
            <p className="mt-2 text-center text-xs text-muted-foreground/50">
              Connect at least one provider to continue
            </p>
          ) : null}
        </m.div>
      </div>
    </LazyMotion>
  );
}
