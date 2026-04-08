import assert from "node:assert/strict";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { NetService } from "shared/Net";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import * as CliError from "effect/unstable/cli/CliError";
import { Command } from "effect/unstable/cli";
import { describe, it } from "vitest";

import { cli } from "./cli.ts";
import { HostedShioriAuthTokenStore } from "./hostedShioriAuthTokenStore.ts";
import { OrchestrationEngineService } from "./orchestration/Services/OrchestrationEngine.ts";
import { ServerSettingsService } from "./serverSettings.ts";

const CliRuntimeLayer = Layer.mergeAll(
  NodeServices.layer,
  NetService.layer,
  ServerSettingsService.layerTest(),
  Layer.succeed(OrchestrationEngineService, {
    getReadModel: () =>
      Effect.succeed({
        snapshotSequence: 0,
        updatedAt: new Date().toISOString(),
        projects: [],
        threads: [],
      }),
    readEvents: () => Stream.empty,
    dispatch: () => Effect.succeed({ sequence: 0 }),
    streamDomainEvents: Stream.empty,
  }),
  Layer.succeed(HostedShioriAuthTokenStore, {
    getToken: Effect.succeed(null),
    setToken: () => Effect.void,
    streamChanges: Stream.empty,
  }),
);

describe("cli log-level parsing", () => {
  it("accepts the built-in lowercase log-level flag values", async () => {
    await Effect.runPromise(
      Effect.scoped(
        Command.runWith(cli, { version: "0.0.0" })(["--log-level", "debug", "--version"]).pipe(
          Effect.provide(CliRuntimeLayer),
        ),
      ),
    );
  });

  it("rejects invalid log-level casing before launching the server", async () => {
    const error = await Effect.runPromise(
      Effect.scoped(
        Command.runWith(cli, { version: "0.0.0" })(["--log-level", "Debug"]).pipe(
          Effect.provide(CliRuntimeLayer),
          Effect.flip,
        ),
      ),
    );

    if (!CliError.isCliError(error)) {
      assert.fail(`Expected CliError, got ${String(error)}`);
    }
    if (error._tag !== "InvalidValue") {
      assert.fail(`Expected InvalidValue, got ${error._tag}`);
    }
    assert.equal(error.option, "log-level");
    assert.equal(error.value, "Debug");
  });
});
