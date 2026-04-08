import { Effect, Logger, References, Layer } from "effect";

import { ServerConfig } from "./config";
import { makeSigNozLogger } from "./telemetry/Layers/SigNozLogger.ts";

export const ServerLoggerLive = Effect.gen(function* () {
  const config = yield* ServerConfig;
  const { serverLogPath } = config;
  const sigNozLogger = yield* makeSigNozLogger;

  const fileLogger = Logger.formatSimple.pipe(Logger.toFile(serverLogPath));
  const minimumLogLevelLayer = Layer.succeed(References.MinimumLogLevel, config.logLevel);
  const loggerLayer = Logger.layer(
    [Logger.consolePretty(), fileLogger, ...(sigNozLogger ? [sigNozLogger] : [])],
    {
      mergeWithExisting: false,
    },
  );

  return Layer.mergeAll(loggerLayer, minimumLogLevelLayer);
}).pipe(Layer.unwrap);
