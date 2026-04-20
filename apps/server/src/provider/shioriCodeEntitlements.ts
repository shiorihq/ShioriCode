import { Effect } from "effect";
import {
  createHostedShioriHeaders,
  isHostedShioriAuthToken,
  normalizeHostedShioriApiBaseUrl,
} from "../hostedShioriApi";

export interface ShioriCodeEntitlements {
  readonly allowed: boolean;
  readonly plan: string | null;
  readonly status: string | null;
}

export interface ShioriCodeEntitlementsProbe {
  readonly entitlements: ShioriCodeEntitlements | null;
  readonly message: string | null;
  readonly authFailure: boolean;
}

const ENTITLEMENTS_REQUEST_TIMEOUT_MS = 2_500;

function resolveShioriCodeEntitlementsMessage(entitlements: ShioriCodeEntitlements): string | null {
  const hasPaidPlan = entitlements.plan !== null && entitlements.plan !== "free";
  const isActive = entitlements.status === "active" || entitlements.status === "grace";
  if (hasPaidPlan && isActive && !entitlements.allowed) {
    return "ShioriCode is disabled for this Shiori deployment. Enable the `code_enabled` feature flag in Convex.";
  }
  return null;
}

function isShioriAuthFailureMessage(message: string | null): boolean {
  if (!message) {
    return false;
  }
  const lower = message.toLowerCase();
  return (
    lower.includes("could not verify oidc token claim") ||
    lower.includes("token signature is valid") ||
    lower.includes("token hasn't expired") ||
    lower.includes("jwt expired") ||
    lower.includes("invalid refresh token") ||
    lower.includes("invalid_grant") ||
    lower.includes("authentication required")
  );
}

async function parseErrorPayload(response: Response): Promise<{ errorMessage: string | null }> {
  const payload = await response
    .json()
    .catch(() => null as unknown)
    .then((value) =>
      value && typeof value === "object" && !Array.isArray(value)
        ? (value as Record<string, unknown>)
        : null,
    );

  const message =
    payload && typeof payload.message === "string"
      ? payload.message
      : payload && typeof payload.error === "string"
        ? payload.error
        : null;

  return {
    errorMessage: message,
  };
}

export const fetchShioriCodeEntitlements = Effect.fn("fetchShioriCodeEntitlements")(
  function* (input: {
    readonly apiBaseUrl: string;
    readonly authToken: string | null;
  }): Effect.fn.Return<ShioriCodeEntitlementsProbe> {
    if (!isHostedShioriAuthToken(input.authToken)) {
      return {
        entitlements: null,
        message: null,
        authFailure: false,
      };
    }
    const authToken = input.authToken;

    const response = yield* Effect.promise(() => {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), ENTITLEMENTS_REQUEST_TIMEOUT_MS);
      return fetch(
        `${normalizeHostedShioriApiBaseUrl(input.apiBaseUrl)}/api/shiori-code/entitlements`,
        {
          headers: createHostedShioriHeaders(authToken),
          signal: controller.signal,
        },
      )
        .catch(() => null)
        .finally(() => {
          clearTimeout(timeoutId);
        });
    });

    if (!response) {
      return {
        entitlements: null,
        message: "Failed to verify the Shiori subscription for this account.",
        authFailure: false,
      };
    }

    const errorPayload = !response.ok
      ? yield* Effect.promise(() => parseErrorPayload(response))
      : null;

    if (response.status === 401) {
      return {
        entitlements: null,
        message: "Shiori account token is unavailable or expired. Sign out and sign back in.",
        authFailure: true,
      };
    }

    if (!response.ok) {
      const authFailure = isShioriAuthFailureMessage(errorPayload?.errorMessage ?? null);
      return {
        entitlements: null,
        message: authFailure
          ? "Shiori account token is unavailable or expired. Sign out and sign back in."
          : `Failed to verify the Shiori subscription (${response.status}).`,
        authFailure,
      };
    }

    const payload = yield* Effect.promise(() =>
      response
        .json()
        .then((value) =>
          value && typeof value === "object" && !Array.isArray(value)
            ? (value as Record<string, unknown>)
            : {},
        )
        .catch(() => ({}) as Record<string, unknown>),
    );

    const entitlements = {
      allowed: payload.allowed === true,
      plan: typeof payload.plan === "string" ? payload.plan : null,
      status: typeof payload.status === "string" ? payload.status : null,
    } satisfies ShioriCodeEntitlements;

    return {
      entitlements,
      message: resolveShioriCodeEntitlementsMessage(entitlements),
      authFailure: false,
    };
  },
);
