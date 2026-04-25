import {
  type ConvexAuthActionsContext,
  useAuthActions,
  useAuthToken,
} from "@convex-dev/auth/react";
import { useConvexAuth, useQuery } from "convex/react";
import { createContext, useContext, useEffect, useMemo, type ReactNode } from "react";

import {
  hostedFlagGetQuery,
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
  mobileAppEnabled: boolean;
  browserUseEnabled: boolean;
  computerUseEnabled: boolean;
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
  mobileAppEnabled: false,
  browserUseEnabled: false,
  computerUseEnabled: false,
  catalogProviders: undefined,
  signIn: noopSignIn,
  signOut: noopSignOut,
});

export function HostedShioriProvider({ children }: { children: ReactNode }) {
  const { isAuthenticated, isLoading } = useConvexAuth();
  const authToken = useAuthToken();
  const normalizedAuthToken = normalizeHostedShioriAuthToken(authToken);
  const viewer = useQuery(hostedCurrentUserQuery, {});
  const mobileAppEnabledFlag = useQuery(
    hostedFlagGetQuery,
    isAuthenticated ? { key: "shioricode_mobile_enabled" } : "skip",
  );
  const browserUseEnabledFlag = useQuery(
    hostedFlagGetQuery,
    isAuthenticated ? { key: "shioricode_browser_use_enabled" } : "skip",
  );
  const computerUseEnabledFlag = useQuery(
    hostedFlagGetQuery,
    isAuthenticated ? { key: "shioricode_computer_use_enabled" } : "skip",
  );
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
      return;
    }

    if (
      isAuthenticated &&
      (mobileAppEnabledFlag === undefined ||
        browserUseEnabledFlag === undefined ||
        computerUseEnabledFlag === undefined)
    ) {
      return;
    }

    const computerUseAvailable = isAuthenticated && computerUseEnabledFlag === true;

    void api.server.updateSettings({
      browserUse: {
        enabled: isAuthenticated && browserUseEnabledFlag === true,
      },
      mobileApp: {
        enabled: isAuthenticated && mobileAppEnabledFlag === true,
      },
      ...(computerUseAvailable
        ? {}
        : {
            computerUse: {
              enabled: false,
            },
          }),
    });
  }, [browserUseEnabledFlag, computerUseEnabledFlag, isAuthenticated, mobileAppEnabledFlag]);

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
      mobileAppEnabled: mobileAppEnabledFlag === true,
      browserUseEnabled: isAuthenticated && browserUseEnabledFlag === true,
      computerUseEnabled: isAuthenticated && computerUseEnabledFlag === true,
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
      browserUseEnabledFlag,
      computerUseEnabledFlag,
      mobileAppEnabledFlag,
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
