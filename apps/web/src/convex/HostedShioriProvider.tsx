import {
  type ConvexAuthActionsContext,
  useAuthActions,
  useAuthToken,
} from "@convex-dev/auth/react";
import { useConvexAuth, useQuery } from "convex/react";
import { createContext, useCallback, useContext, useEffect, useMemo, type ReactNode } from "react";
import {
  decodeHostedShioriAuthTokenClaims,
  hostedShioriAuthTokenMatchesConvexUrl,
} from "shared/hostedShioriConvex";
import { readHostedShioriFeatureFlagOverride } from "shared/hostedShioriFeatureFlags";

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
import { convexDeploymentUrl } from "./config";

const hostedFeatureFlagEnv = import.meta.env as Record<string, unknown>;

function normalizeHostedShioriAuthToken(token: string | null): string | null {
  const trimmed = token?.trim() ?? "";
  return hostedShioriAuthTokenMatchesConvexUrl({
    token: trimmed,
    convexUrl: convexDeploymentUrl,
  })
    ? trimmed
    : null;
}

function describeHostedShioriAuthToken(token: string | null) {
  const claims = decodeHostedShioriAuthTokenClaims(token);
  return {
    present: token !== null,
    jwtLike: token !== null,
    issuer: claims?.iss ?? null,
    audience: claims?.aud ?? null,
    subject: claims?.sub ?? null,
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
  goalsEnabled: boolean;
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
  goalsEnabled: false,
  catalogProviders: undefined,
  signIn: noopSignIn,
  signOut: noopSignOut,
});

export function HostedShioriProvider({ children }: { children: ReactNode }) {
  const { isAuthenticated, isLoading } = useConvexAuth();
  const authToken = useAuthToken();
  const normalizedAuthToken = normalizeHostedShioriAuthToken(authToken);
  const viewer = useQuery(hostedCurrentUserQuery, {});
  const mobileAppEnabledOverride = readHostedShioriFeatureFlagOverride(
    "shioricode_mobile_enabled",
    hostedFeatureFlagEnv,
  );
  const browserUseEnabledOverride = readHostedShioriFeatureFlagOverride(
    "shioricode_browser_use_enabled",
    hostedFeatureFlagEnv,
  );
  const computerUseEnabledOverride = readHostedShioriFeatureFlagOverride(
    "shioricode_computer_use_enabled",
    hostedFeatureFlagEnv,
  );
  const goalsEnabledOverride = readHostedShioriFeatureFlagOverride(
    "shioricode_goals_enabled",
    hostedFeatureFlagEnv,
  );
  const mobileAppEnabledFlag = useQuery(
    hostedFlagGetQuery,
    isAuthenticated && mobileAppEnabledOverride === undefined
      ? { key: "shioricode_mobile_enabled" }
      : "skip",
  );
  const browserUseEnabledFlag = useQuery(
    hostedFlagGetQuery,
    isAuthenticated && browserUseEnabledOverride === undefined
      ? { key: "shioricode_browser_use_enabled" }
      : "skip",
  );
  const computerUseEnabledFlag = useQuery(
    hostedFlagGetQuery,
    isAuthenticated && computerUseEnabledOverride === undefined
      ? { key: "shioricode_computer_use_enabled" }
      : "skip",
  );
  const goalsEnabledFlag = useQuery(
    hostedFlagGetQuery,
    isAuthenticated && goalsEnabledOverride === undefined
      ? { key: "shioricode_goals_enabled" }
      : "skip",
  );
  const mobileAppEnabled =
    mobileAppEnabledOverride ?? (isAuthenticated && mobileAppEnabledFlag === true);
  const browserUseEnabled =
    browserUseEnabledOverride ?? (isAuthenticated && browserUseEnabledFlag === true);
  const computerUseEnabled =
    computerUseEnabledOverride ?? (isAuthenticated && computerUseEnabledFlag === true);
  const goalsEnabled = goalsEnabledOverride ?? (isAuthenticated && goalsEnabledFlag === true);
  const userWithUsage = useQuery(hostedUserWithUsageQuery, isAuthenticated ? {} : "skip");
  const subscriptionPlanId =
    !isAuthenticated || userWithUsage === undefined
      ? null
      : normalizeHostedSubscriptionPlanId(userWithUsage?.subscription?.plan ?? "free");
  const subscriptionPlanLabel =
    subscriptionPlanId === null ? null : hostedSubscriptionPlanLabel(subscriptionPlanId);
  const isPaidSubscriber = subscriptionPlanId !== null && subscriptionPlanId !== "free";
  const isSubscriptionLoading = isAuthenticated && userWithUsage === undefined;
  const catalogProviders = useQuery(hostedModelsListQuery, isAuthenticated ? {} : "skip");
  const { signIn, signOut } = useAuthActions();
  const signOutAndClearDesktopToken = useCallback<ConvexAuthActionsContext["signOut"]>(
    async (...args) => {
      await signOut(...args);
      const api = readNativeApi();
      await api?.server.setShioriAuthToken(null);
    },
    [signOut],
  );

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
      ((mobileAppEnabledOverride === undefined && mobileAppEnabledFlag === undefined) ||
        (browserUseEnabledOverride === undefined && browserUseEnabledFlag === undefined) ||
        (computerUseEnabledOverride === undefined && computerUseEnabledFlag === undefined) ||
        (goalsEnabledOverride === undefined && goalsEnabledFlag === undefined))
    ) {
      return;
    }

    const computerUseAvailable = computerUseEnabled;

    void api.server.updateSettings({
      browserUse: {
        enabled: browserUseEnabled,
      },
      mobileApp: {
        enabled: mobileAppEnabled,
      },
      goals: {
        enabled: goalsEnabled,
      },
      ...(computerUseAvailable
        ? {}
        : {
            computerUse: {
              enabled: false,
            },
          }),
    });
  }, [
    browserUseEnabled,
    browserUseEnabledFlag,
    browserUseEnabledOverride,
    computerUseEnabled,
    computerUseEnabledFlag,
    computerUseEnabledOverride,
    goalsEnabled,
    isAuthenticated,
    goalsEnabledFlag,
    goalsEnabledOverride,
    mobileAppEnabled,
    mobileAppEnabledFlag,
    mobileAppEnabledOverride,
  ]);

  useEffect(() => {
    const api = readNativeApi();
    if (!api) {
      console.info("[shiori-auth] native api unavailable during token sync", {
        token: describeHostedShioriAuthToken(normalizedAuthToken),
      });
      return;
    }

    if (normalizedAuthToken === null) {
      console.info("[shiori-auth] skipping empty Shiori account token sync", {
        isAuthenticated,
        isLoading,
      });
      return;
    }

    console.info("[shiori-auth] syncing Shiori account token to desktop server", {
      token: describeHostedShioriAuthToken(normalizedAuthToken),
    });
    void api.server.setShioriAuthToken(normalizedAuthToken);
  }, [isAuthenticated, isLoading, normalizedAuthToken]);

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
      mobileAppEnabled,
      browserUseEnabled,
      computerUseEnabled,
      goalsEnabled,
      catalogProviders,
      signIn,
      signOut: signOutAndClearDesktopToken,
    }),
    [
      catalogProviders,
      isAuthenticated,
      isLoading,
      isPaidSubscriber,
      isSubscriptionLoading,
      normalizedAuthToken,
      browserUseEnabled,
      computerUseEnabled,
      goalsEnabled,
      mobileAppEnabled,
      signIn,
      signOutAndClearDesktopToken,
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
