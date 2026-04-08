import type { TelemetryLogLevel, TelemetryProperties } from "contracts";

import { isElectron } from "./env";
import { readNativeApi } from "./nativeApi";

const DUPLICATE_ERROR_WINDOW_MS = 30_000;
const recentClientErrorTimestamps = new Map<string, number>();

function withClientContext(properties?: TelemetryProperties): Readonly<Record<string, unknown>> {
  return {
    platform: isElectron ? "desktop" : "web",
    ...properties,
  };
}

function invokeTelemetry(
  action: (api: NonNullable<ReturnType<typeof readNativeApi>>) => Promise<void>,
) {
  const api = readNativeApi();
  if (!api) {
    return;
  }

  void action(api).catch(() => undefined);
}

export function recordTelemetry(event: string, properties?: TelemetryProperties) {
  invokeTelemetry((api) =>
    api.telemetry.capture({
      event,
      properties: withClientContext(properties),
    }),
  );
}

export function logTelemetry(
  level: TelemetryLogLevel,
  message: string,
  context?: TelemetryProperties,
) {
  invokeTelemetry((api) =>
    api.telemetry.log({
      level,
      message,
      context: withClientContext(context),
    }),
  );
}

export function logTelemetryErrorOnce(message: string, context?: TelemetryProperties) {
  const key = JSON.stringify([message, context ?? null]);
  const now = Date.now();
  const lastTimestamp = recentClientErrorTimestamps.get(key);

  if (lastTimestamp !== undefined && now - lastTimestamp < DUPLICATE_ERROR_WINDOW_MS) {
    return;
  }

  recentClientErrorTimestamps.set(key, now);
  logTelemetry("error", message, context);
}
