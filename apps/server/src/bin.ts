import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { Command } from "effect/unstable/cli";

import { NetService } from "shared/Net";
import { cli } from "./cli";
import { version } from "../package.json" with { type: "json" };

const CliRuntimeLayer = Layer.mergeAll(NodeServices.layer, NetService.layer);

NodeRuntime.runMain(
  Command.run(cli, { version }).pipe(
    Effect.provide(CliRuntimeLayer),
    Effect.scoped,
  ) as Effect.Effect<void, never, never>,
);
