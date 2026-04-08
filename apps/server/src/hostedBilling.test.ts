import { HostedBillingError } from "contracts/server";
import { DEFAULT_SERVER_SETTINGS } from "contracts/settings";
import { Effect, Layer, Stream } from "effect";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { HostedBillingLive, HostedBillingService } from "./hostedBilling";
import { HostedShioriAuthTokenStore } from "./hostedShioriAuthTokenStore";
import { ServerSettingsService } from "./serverSettings";

const jwtToken = "header.payload.signature";

const authTokenLayer = (token: string | null) =>
  Layer.succeed(HostedShioriAuthTokenStore, {
    getToken: Effect.succeed(token),
    setToken: () => Effect.void,
    streamChanges: Stream.empty,
  });

const makeTestLayer = (options?: { apiBaseUrl?: string; authToken?: string | null }) =>
  HostedBillingLive.pipe(
    Layer.provide(
      ServerSettingsService.layerTest({
        ...DEFAULT_SERVER_SETTINGS,
        providers: {
          ...DEFAULT_SERVER_SETTINGS.providers,
          shiori: {
            ...DEFAULT_SERVER_SETTINGS.providers.shiori,
            apiBaseUrl: options?.apiBaseUrl ?? "https://shiori.ai",
          },
        },
      }),
    ),
    Layer.provide(authTokenLayer(options?.authToken ?? jwtToken)),
  );

describe("HostedBillingLive", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("fetches hosted billing plans with the desktop auth headers", async () => {
    const fetchMock = vi.mocked(fetch);
    fetchMock.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          plans: [
            {
              id: "plus",
              name: "Plus",
              description: "Starter paid plan",
              monthlyPrice: 10,
              annualPrice: 96,
              sortOrder: 0,
              highlighted: true,
              buttonText: "Get Plus",
              features: ["Feature A"],
            },
          ],
        }),
        { status: 200 },
      ),
    );

    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const service = yield* HostedBillingService;
        return yield* service.getSnapshot;
      }).pipe(Effect.provide(makeTestLayer())),
    );

    expect(result).toEqual({
      plans: [
        {
          id: "plus",
          name: "Plus",
          description: "Starter paid plan",
          monthlyPrice: 10,
          annualPrice: 96,
          sortOrder: 0,
          highlighted: true,
          buttonText: "Get Plus",
          features: ["Feature A"],
        },
      ],
    });
    expect(fetchMock).toHaveBeenCalledWith("https://shiori.ai/api/shiori-code/billing/plans", {
      method: "GET",
      headers: {
        "Content-Type": "application/json",
        "X-Convex-Auth-Token": jwtToken,
        "X-Shiori-Client": "electron",
        "User-Agent": "ShioriCode-macOS/1.0",
      },
    });
  });

  it("posts checkout requests through the hosted billing bridge", async () => {
    const fetchMock = vi.mocked(fetch);
    fetchMock.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          sessionId: "cs_test_1",
          url: "https://checkout.stripe.test/session",
        }),
        { status: 200 },
      ),
    );

    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const service = yield* HostedBillingService;
        return yield* service.createCheckout({ planId: "pro", isAnnual: true });
      }).pipe(Effect.provide(makeTestLayer())),
    );

    expect(result).toEqual({
      sessionId: "cs_test_1",
      url: "https://checkout.stripe.test/session",
    });
    expect(fetchMock).toHaveBeenCalledWith("https://shiori.ai/api/shiori-code/billing/checkout", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Convex-Auth-Token": jwtToken,
        "X-Shiori-Client": "electron",
        "User-Agent": "ShioriCode-macOS/1.0",
      },
      body: JSON.stringify({
        planId: "pro",
        isAnnual: true,
      }),
    });
  });

  it("maps 401 responses to an authentication error", async () => {
    const fetchMock = vi.mocked(fetch);
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ error: "User not authenticated" }), { status: 401 }),
    );

    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const service = yield* HostedBillingService;
        return yield* Effect.result(service.getSnapshot);
      }).pipe(Effect.provide(makeTestLayer())),
    );

    expect(result._tag).toBe("Failure");
    if (result._tag !== "Failure") {
      throw new Error("Expected hosted billing failure");
    }
    const error = result.failure;
    expect(error).toBeInstanceOf(HostedBillingError);
    expect(error.code).toBe("authentication");
    expect(error.message).toBe("User not authenticated");
  });

  it("fails fast when the Shiori API base URL is missing", async () => {
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const service = yield* HostedBillingService;
        return yield* Effect.result(service.getSnapshot);
      }).pipe(Effect.provide(makeTestLayer({ apiBaseUrl: "" }))),
    );

    expect(result._tag).toBe("Failure");
    if (result._tag !== "Failure") {
      throw new Error("Expected hosted billing failure");
    }
    const error = result.failure;
    expect(error).toBeInstanceOf(HostedBillingError);
    expect(error.code).toBe("configuration");
    expect(error.message).toBe("Configure the Shiori API base URL to enable billing.");
  });
});
