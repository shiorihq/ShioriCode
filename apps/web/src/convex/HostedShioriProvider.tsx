import {
  type ConvexAuthActionsContext,
  useAuthActions,
  useAuthToken,
} from "@convex-dev/auth/react";
import { useConvexAuth, useQuery } from "convex/react";
import { createContext, useContext, useEffect, useMemo, type ReactNode } from "react";

import {
  hostedCurrentUserQuery,
  hostedModelsListQuery,
  hostedUserWithUsageQuery,
  type HostedCatalogProvider,
  type HostedSubscriptionPlanId,
  type HostedViewer,
} from "./api";
import {
  hostedSubscriptionPlanLabel,
  normalizeHostedSubscriptionPlanId,
} from "./hostedSubscriptionPlan";
import { readNativeApi, setNativeApiWebConnectGate } from "../nativeApi";

function normalizeHostedShioriAuthToken(token: string | null): string | null {
  const trimmed = token?.trim() ?? "";
  return /^[^.]+\.[^.]+\.[^.]+$/.test(trimmed) ? trimmed : null;
}

function describeHostedShioriAuthToken(token: string | null) {
  return {
    present: token !== null,
    jwtLike: token !== null,
  };
}

interface HostedShioriState {
  isAuthLoading: boolean;
  isAuthenticated: boolean;
  isSubscriptionLoading: boolean;
  isPaidSubscriber: boolean;
  /** Resolved tier once usage is loaded; null while the usage query is in flight. */
  subscriptionPlanId: HostedSubscriptionPlanId | null;
  subscriptionPlanLabel: string | null;
  authToken: string | null;
  viewer: HostedViewer | null | undefined;
  catalogProviders: ReadonlyArray<HostedCatalogProvider> | undefined;
  signIn: ConvexAuthActionsContext["signIn"];
  signOut: ConvexAuthActionsContext["signOut"];
}

const noopSignIn: ConvexAuthActionsContext["signIn"] = async () => ({
  signingIn: false,
});
const noopSignOut: ConvexAuthActionsContext["signOut"] = async () => undefined;

const HostedShioriContext = createContext<HostedShioriState>({
  isAuthLoading: false,
  isAuthenticated: false,
  isSubscriptionLoading: false,
  isPaidSubscriber: false,
  subscriptionPlanId: null,
  subscriptionPlanLabel: null,
  authToken: null,
  viewer: null,
  catalogProviders: undefined,
  signIn: noopSignIn,
  signOut: noopSignOut,
});

export function HostedShioriProvider({ children }: { children: ReactNode }) {
  const { isAuthenticated, isLoading } = useConvexAuth();
  const authToken = useAuthToken();
  const normalizedAuthToken = normalizeHostedShioriAuthToken(authToken);
  const viewer = useQuery(hostedCurrentUserQuery, {});
  const userWithUsage = useQuery(hostedUserWithUsageQuery, isAuthenticated ? {} : "skip");
  const subscriptionPlanId =
    !isAuthenticated || userWithUsage === undefined
      ? null
      : normalizeHostedSubscriptionPlanId(userWithUsage?.subscription?.plan ?? "free");
  const subscriptionPlanLabel =
    subscriptionPlanId === null ? null : hostedSubscriptionPlanLabel(subscriptionPlanId);
  const isPaidSubscriber = subscriptionPlanId !== null && subscriptionPlanId !== "free";
  const isSubscriptionLoading = isAuthenticated && userWithUsage === undefined;
  const catalogProviders = useQuery(
    hostedModelsListQuery,
    isAuthenticated && isPaidSubscriber ? {} : "skip",
  );
  const { signIn, signOut } = useAuthActions();

  useEffect(() => {
    setNativeApiWebConnectGate(isAuthenticated);
  }, [isAuthenticated]);

  useEffect(() => {
    const api = readNativeApi();
    if (!api) {
      console.info("[shiori-auth] native api unavailable during token sync", {
        token: describeHostedShioriAuthToken(normalizedAuthToken),
      });
      return;
    }

    console.info("[shiori-auth] syncing Shiori account token to desktop server", {
      token: describeHostedShioriAuthToken(normalizedAuthToken),
    });
    void api.server.setShioriAuthToken(normalizedAuthToken);
  }, [isAuthenticated, normalizedAuthToken]);

  const value = useMemo(
    () => ({
      isAuthLoading: isLoading,
      isAuthenticated,
      isSubscriptionLoading,
      isPaidSubscriber,
      subscriptionPlanId,
      subscriptionPlanLabel,
      authToken: normalizedAuthToken,
      viewer,
      catalogProviders,
      signIn,
      signOut,
    }),
    [
      catalogProviders,
      isAuthenticated,
      isLoading,
      isPaidSubscriber,
      isSubscriptionLoading,
      normalizedAuthToken,
      signIn,
      signOut,
      subscriptionPlanId,
      subscriptionPlanLabel,
      viewer,
    ],
  );

  return <HostedShioriContext.Provider value={value}>{children}</HostedShioriContext.Provider>;
}

export function useHostedShioriState(): HostedShioriState {
  return useContext(HostedShioriContext);
}
