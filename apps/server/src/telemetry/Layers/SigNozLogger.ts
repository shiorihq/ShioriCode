import { Config, Effect, Logger } from "effect";
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/unstable/http";

import { ServerConfig } from "../../config.ts";
import { version } from "../../../package.json" with { type: "json" };

const SigNozConfig = Config.all({
  endpoint: Config.string("OTEL_EXPORTER_OTLP_ENDPOINT").pipe(
    Config.withDefault("https://otel.shiori.ai"),
  ),
  serviceName: Config.string("OTEL_SERVICE_NAME").pipe(Config.withDefault("shioricode")),
  enabled: Config.boolean("SHIORICODE_SIGNOZ_LOGS_ENABLED").pipe(Config.withDefault(true)),
  batchWindowMs: Config.number("SHIORICODE_SIGNOZ_LOGS_BATCH_WINDOW_MS").pipe(
    Config.withDefault(1_000),
  ),
  maxBatchSize: Config.number("SHIORICODE_SIGNOZ_LOGS_MAX_BATCH_SIZE").pipe(
    Config.withDefault(200),
  ),
});

export interface StructuredLogEntry {
  readonly message: unknown;
  readonly level: string;
  readonly timestamp: string;
  readonly cause?: string;
  readonly annotations: Record<string, unknown>;
  readonly spans: Record<string, number>;
  readonly fiberId: string;
}

function normalizeEndpoint(endpoint: string): string {
  return endpoint.endsWith("/") ? endpoint.slice(0, -1) : endpoint;
}

function toSeverityNumber(level: string): number {
  switch (level.toUpperCase()) {
    case "TRACE":
      return 1;
    case "DEBUG":
      return 5;
    case "WARN":
      return 13;
    case "ERROR":
      return 17;
    case "FATAL":
      return 21;
    case "INFO":
    default:
      return 9;
  }
}

function toUnixTimeNanos(timestamp: string): string {
  const parsed = Date.parse(timestamp);
  const millis = Number.isFinite(parsed) ? parsed : Date.now();
  return String(BigInt(millis) * 1_000_000n);
}

function stringifyValue(value: unknown): string {
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean" || value === null) {
    return String(value);
  }
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function toAnyValue(value: unknown, depth = 0): Record<string, unknown> {
  if (depth > 4) {
    return { stringValue: stringifyValue(value) };
  }
  if (value === null || value === undefined) {
    return { stringValue: String(value) };
  }
  if (typeof value === "string") {
    return { stringValue: value };
  }
  if (typeof value === "boolean") {
    return { boolValue: value };
  }
  if (typeof value === "number") {
    return Number.isFinite(value) ? { doubleValue: value } : { stringValue: String(value) };
  }
  if (typeof value === "bigint") {
    return { stringValue: value.toString() };
  }
  if (value instanceof Date) {
    return { stringValue: value.toISOString() };
  }
  if (Array.isArray(value)) {
    return {
      arrayValue: {
        values: value.map((entry) => toAnyValue(entry, depth + 1)),
      },
    };
  }
  if (typeof value === "object") {
    return {
      kvlistValue: {
        values: Object.entries(value).map(([key, nestedValue]) => ({
          key,
          value: toAnyValue(nestedValue, depth + 1),
        })),
      },
    };
  }
  return { stringValue: String(value) };
}

function toAttributeEntries(attributes: Record<string, unknown>): Array<Record<string, unknown>> {
  return Object.entries(attributes)
    .filter(([, value]) => value !== undefined)
    .map(([key, value]) => ({
      key,
      value: toAnyValue(value),
    }));
}

export function encodeSigNozLogPayload(input: {
  readonly logs: ReadonlyArray<StructuredLogEntry>;
  readonly serviceName: string;
  readonly serviceVersion: string;
  readonly deploymentEnvironment: string;
  readonly runtimeMode: string;
}): Record<string, unknown> {
  return {
    resourceLogs: [
      {
        resource: {
          attributes: toAttributeEntries({
            "service.name": input.serviceName,
            "service.version": input.serviceVersion,
            "deployment.environment": input.deploymentEnvironment,
            "shioricode.runtime_mode": input.runtimeMode,
            "process.runtime.name": "node",
          }),
        },
        scopeLogs: [
          {
            scope: {
              name: input.serviceName,
              version: input.serviceVersion,
            },
            logRecords: input.logs.map((log) => ({
              timeUnixNano: toUnixTimeNanos(log.timestamp),
              severityNumber: toSeverityNumber(log.level),
              severityText: log.level,
              body: toAnyValue(log.message),
              attributes: toAttributeEntries({
                message: stringifyValue(log.message),
                fiberId: log.fiberId,
                cause: log.cause,
                annotations: log.annotations,
                spans: log.spans,
              }),
            })),
          },
        ],
      },
    ],
  };
}

const flushBatches = Effect.fn("flushBatches")(function* (
  httpClient: HttpClient.HttpClient,
  endpoint: string,
  payload: {
    readonly logs: ReadonlyArray<StructuredLogEntry>;
    readonly serviceName: string;
    readonly serviceVersion: string;
    readonly deploymentEnvironment: string;
    readonly runtimeMode: string;
  },
  maxBatchSize: number,
) {
  const url = `${normalizeEndpoint(endpoint)}/v1/logs`;
  const chunks =
    payload.logs.length <= maxBatchSize
      ? [payload.logs]
      : Array.from(
          {
            length: Math.ceil(payload.logs.length / maxBatchSize),
          },
          (_, index) =>
            payload.logs.slice(index * maxBatchSize, index * maxBatchSize + maxBatchSize),
        );

  for (const chunk of chunks) {
    const body = encodeSigNozLogPayload({
      ...payload,
      logs: chunk,
    });
    yield* HttpClientRequest.post(url).pipe(
      HttpClientRequest.bodyJson(body),
      Effect.flatMap(httpClient.execute),
      Effect.flatMap(HttpClientResponse.filterStatusOk),
    );
  }
});

export const makeSigNozLogger = Effect.gen(function* () {
  const config = yield* SigNozConfig.asEffect();
  const httpClient = yield* HttpClient.HttpClient;
  const serverConfig = yield* ServerConfig;

  if (!config.enabled) {
    return null;
  }

  return yield* Logger.batched(Logger.formatStructured, {
    window: config.batchWindowMs,
    flush: (messages) =>
      flushBatches(
        httpClient,
        config.endpoint,
        {
          logs: messages as ReadonlyArray<StructuredLogEntry>,
          serviceName: config.serviceName,
          serviceVersion: version,
          deploymentEnvironment: process.env.NODE_ENV ?? "development",
          runtimeMode: serverConfig.mode,
        },
        config.maxBatchSize,
      ).pipe(
        Effect.catchCause(() =>
          Effect.sync(() => {
            console.error("[server] failed to export logs to SigNoz");
          }),
        ),
      ),
  });
});
