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
  type HostedViewer,
} from "./api";
import { readNativeApi } from "../nativeApi";

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
  const subscriptionPlan = userWithUsage?.subscription?.plan ?? null;
  const isPaidSubscriber = subscriptionPlan !== null && subscriptionPlan !== "free";
  const isSubscriptionLoading = isAuthenticated && userWithUsage === undefined;
  const catalogProviders = useQuery(
    hostedModelsListQuery,
    isAuthenticated && isPaidSubscriber ? {} : "skip",
  );
  const { signIn, signOut } = useAuthActions();

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
  }, [normalizedAuthToken]);

  const value = useMemo(
    () => ({
      isAuthLoading: isLoading,
      isAuthenticated,
      isSubscriptionLoading,
      isPaidSubscriber,
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
      viewer,
    ],
  );

  return <HostedShioriContext.Provider value={value}>{children}</HostedShioriContext.Provider>;
}

export function useHostedShioriState(): HostedShioriState {
  return useContext(HostedShioriContext);
}
