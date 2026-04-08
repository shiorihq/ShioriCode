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
}

const ENTITLEMENTS_REQUEST_TIMEOUT_MS = 2_500;

export const fetchShioriCodeEntitlements = Effect.fn("fetchShioriCodeEntitlements")(
  function* (input: {
    readonly apiBaseUrl: string;
    readonly authToken: string | null;
  }): Effect.fn.Return<ShioriCodeEntitlementsProbe> {
    if (!isHostedShioriAuthToken(input.authToken)) {
      return {
        entitlements: null,
        message: null,
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
      };
    }

    if (response.status === 401) {
      return {
        entitlements: null,
        message: "Shiori account token is unavailable or expired. Sign out and sign back in.",
      };
    }

    if (!response.ok) {
      return {
        entitlements: null,
        message: `Failed to verify the Shiori subscription (${response.status}).`,
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

    return {
      entitlements: {
        allowed: payload.allowed === true,
        plan: typeof payload.plan === "string" ? payload.plan : null,
        status: typeof payload.status === "string" ? payload.status : null,
      },
      message: null,
    };
  },
);
