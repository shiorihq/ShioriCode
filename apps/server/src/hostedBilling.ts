import {
  HostedBillingCheckoutResult,
  HostedBillingError,
  HostedBillingPortalResult,
  HostedBillingSnapshot,
  type HostedBillingCheckoutInput,
  type HostedBillingPortalInput,
} from "contracts/server";
import { Effect, Layer, Schema, ServiceMap } from "effect";

import { HostedShioriAuthTokenStore } from "./hostedShioriAuthTokenStore";
import {
  createHostedShioriHeaders,
  isHostedShioriAuthToken,
  normalizeHostedShioriApiBaseUrl,
} from "./hostedShioriApi";
import { ServerSettingsService } from "./serverSettings";

export interface HostedBillingShape {
  readonly getSnapshot: Effect.Effect<HostedBillingSnapshot, HostedBillingError>;
  readonly createCheckout: (
    input: HostedBillingCheckoutInput,
  ) => Effect.Effect<HostedBillingCheckoutResult, HostedBillingError>;
  readonly createPortal: (
    input: HostedBillingPortalInput,
  ) => Effect.Effect<HostedBillingPortalResult, HostedBillingError>;
}

export class HostedBillingService extends ServiceMap.Service<
  HostedBillingService,
  HostedBillingShape
>()("t3/HostedBillingService") {
  static readonly layerTest = (overrides: Partial<HostedBillingShape>) =>
    Layer.effect(
      HostedBillingService,
      Effect.succeed({
        getSnapshot: Effect.fail(
          new HostedBillingError({
            code: "unavailable",
            message: "Hosted billing snapshot test double is not configured.",
          }),
        ),
        createCheckout: () =>
          Effect.fail(
            new HostedBillingError({
              code: "unavailable",
              message: "Hosted billing checkout test double is not configured.",
            }),
          ),
        createPortal: () =>
          Effect.fail(
            new HostedBillingError({
              code: "unavailable",
              message: "Hosted billing portal test double is not configured.",
            }),
          ),
        ...overrides,
      }),
    );
}

function decodeHostedResponse<A>(
  schema: Schema.Schema<A>,
  payload: unknown,
  message: string,
): Effect.Effect<A, HostedBillingError> {
  return Effect.try({
    try: () => Schema.decodeUnknownSync(schema as never)(payload) as A,
    catch: (cause) =>
      new HostedBillingError({
        code: "unavailable",
        message,
        cause,
      }),
  });
}

function parseResponsePayload(text: string): unknown {
  const trimmed = text.trim();
  if (trimmed.length === 0) {
    return {};
  }

  try {
    return JSON.parse(trimmed);
  } catch {
    return trimmed;
  }
}

function errorMessageFromPayload(payload: unknown): string | null {
  if (payload && typeof payload === "object" && !Array.isArray(payload)) {
    const candidate = (payload as Record<string, unknown>).error;
    if (typeof candidate === "string" && candidate.trim().length > 0) {
      return candidate.trim();
    }
  }

  if (typeof payload === "string" && payload.trim().length > 0) {
    return payload.trim();
  }

  return null;
}

const makeHostedBilling = Effect.gen(function* () {
  const serverSettings = yield* ServerSettingsService;
  const authTokenStore = yield* HostedShioriAuthTokenStore;

  const resolveAccess = Effect.gen(function* () {
    const [{ providers }, authToken] = yield* Effect.all([
      serverSettings.getSettings.pipe(
        Effect.mapError(
          (cause) =>
            new HostedBillingError({
              code: "configuration",
              message: "Failed to read server settings for hosted billing.",
              cause,
            }),
        ),
      ),
      authTokenStore.getToken,
    ]);

    const apiBaseUrl = providers.shiori.apiBaseUrl.trim();
    if (apiBaseUrl.length === 0) {
      return yield* Effect.fail(
        new HostedBillingError({
          code: "configuration",
          message: "Configure the Shiori API base URL to enable billing.",
        }),
      );
    }

    if (!isHostedShioriAuthToken(authToken)) {
      return yield* Effect.fail(
        new HostedBillingError({
          code: "authentication",
          message: "Shiori account token is unavailable or expired. Sign out and sign back in.",
        }),
      );
    }

    const next = {
      apiBaseUrl: normalizeHostedShioriApiBaseUrl(apiBaseUrl),
      authToken,
    };
    return next;
  });

  const requestJson = <A>(input: {
    path: string;
    successSchema: Schema.Schema<A>;
    method?: "GET" | "POST";
    body?: unknown;
    invalidResponseMessage: string;
  }): Effect.Effect<A, HostedBillingError> =>
    Effect.gen(function* () {
      const { apiBaseUrl, authToken } = yield* resolveAccess;
      const response = yield* Effect.tryPromise({
        try: () =>
          fetch(`${apiBaseUrl}${input.path}`, {
            method: input.method ?? "GET",
            headers: createHostedShioriHeaders(authToken),
            ...(input.body !== undefined ? { body: JSON.stringify(input.body) } : {}),
          }),
        catch: (cause) =>
          new HostedBillingError({
            code: "unavailable",
            message: "Failed to reach the Shiori billing service.",
            cause,
          }),
      });

      const responseText = yield* Effect.tryPromise({
        try: () => response.text(),
        catch: (cause) =>
          new HostedBillingError({
            code: "unavailable",
            message: "Failed to read the Shiori billing response.",
            cause,
          }),
      });
      const payload = parseResponsePayload(responseText);

      if (!response.ok) {
        const message = errorMessageFromPayload(payload);

        if (response.status === 401) {
          return yield* Effect.fail(
            new HostedBillingError({
              code: "authentication",
              message:
                message ??
                "Shiori account token is unavailable or expired. Sign out and sign back in.",
              status: response.status,
            }),
          );
        }

        if (response.status === 403) {
          return yield* Effect.fail(
            new HostedBillingError({
              code: "authorization",
              message: message ?? "ShioriCode requires an active paid Shiori subscription.",
              status: response.status,
            }),
          );
        }

        return yield* Effect.fail(
          new HostedBillingError({
            code: response.status >= 500 ? "unavailable" : "requestFailed",
            message: message ?? `Shiori billing request failed with status ${response.status}.`,
            status: response.status,
          }),
        );
      }

      return yield* decodeHostedResponse(
        input.successSchema,
        payload,
        input.invalidResponseMessage,
      );
    }) as Effect.Effect<A, HostedBillingError>;

  return {
    getSnapshot: requestJson({
      path: "/api/shiori-code/billing/plans",
      successSchema: HostedBillingSnapshot,
      invalidResponseMessage: "Invalid billing plans response from Shiori.",
    }),
    createCheckout: (input: HostedBillingCheckoutInput) =>
      requestJson({
        path: "/api/shiori-code/billing/checkout",
        method: "POST",
        body: input,
        successSchema: HostedBillingCheckoutResult,
        invalidResponseMessage: "Invalid billing checkout response from Shiori.",
      }),
    createPortal: (input: HostedBillingPortalInput) =>
      requestJson({
        path: `/api/shiori-code/billing/portal?flow=${input.flow}`,
        successSchema: HostedBillingPortalResult,
        invalidResponseMessage: "Invalid billing portal response from Shiori.",
      }),
  } satisfies HostedBillingShape;
});

export const HostedBillingLive = Layer.effect(HostedBillingService, makeHostedBilling);
