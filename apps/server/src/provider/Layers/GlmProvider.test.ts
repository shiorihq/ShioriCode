import { describe, it, assert } from "@effect/vitest";
import { Effect, Layer, Sink, Stream } from "effect";
import * as PlatformError from "effect/PlatformError";
import { ChildProcessSpawner } from "effect/unstable/process";

import { ServerSettingsService } from "../../serverSettings.ts";
import { checkGlmProviderStatus, getGlmModelCapabilities } from "./GlmProvider.ts";

const encoder = new TextEncoder();

function mockHandle(result: { stdout: string; stderr: string; code: number }) {
  return ChildProcessSpawner.makeHandle({
    pid: ChildProcessSpawner.ProcessId(1),
    exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(result.code)),
    isRunning: Effect.succeed(false),
    kill: () => Effect.void,
    stdin: Sink.drain,
    stdout: Stream.make(encoder.encode(result.stdout)),
    stderr: Stream.make(encoder.encode(result.stderr)),
    all: Stream.empty,
    getInputFd: () => Sink.drain,
    getOutputFd: () => Stream.empty,
  });
}

function toPlatformError(cause: unknown): PlatformError.PlatformError {
  return cause instanceof Error
    ? (cause as unknown as PlatformError.PlatformError)
    : PlatformError.systemError({
        _tag: "Unknown",
        module: "ChildProcess",
        method: "spawn",
        description: String(cause),
      });
}

function mockSpawnerLayer(
  handler: (args: ReadonlyArray<string>) => { stdout: string; stderr: string; code: number },
) {
  return Layer.succeed(
    ChildProcessSpawner.ChildProcessSpawner,
    ChildProcessSpawner.make((command) => {
      const cmd = command as unknown as { args: ReadonlyArray<string> };
      return Effect.try({
        try: () => mockHandle(handler(cmd.args)),
        catch: toPlatformError,
      });
    }),
  );
}

describe("GlmProvider", () => {
  it.effect("advertises the current Z.AI Coding Plan built-in models", () =>
    Effect.gen(function* () {
      const status = yield* checkGlmProviderStatus();

      assert.equal(status.provider, "glm");
      assert.equal(status.status, "ready");
      assert.deepEqual(
        status.models.map((model) => model.slug),
        ["glm-5.2", "glm-5-turbo", "glm-4.7"],
      );
      assert.deepEqual(
        status.models.map((model) => model.name),
        ["GLM-5.2", "GLM-5-Turbo", "GLM-4.7"],
      );
    }).pipe(
      Effect.provide(
        Layer.mergeAll(
          ServerSettingsService.layerTest({
            providers: {
              glm: {
                apiKey: "zai-test-key",
              },
            },
          }),
          mockSpawnerLayer((args) => {
            if (args.join(" ") === "--version") {
              return { stdout: "claude 1.2.3\n", stderr: "", code: 0 };
            }
            throw new Error(`Unexpected GLM health check args: ${args.join(" ")}`);
          }),
        ),
      ),
    ),
  );

  it("scopes the 1M context window capability to GLM-5.2", () => {
    assert.deepEqual(
      getGlmModelCapabilities("glm-5.2[1m]").contextWindowOptions.map((option) => option.value),
      ["200k", "1m"],
    );
    assert.deepEqual(getGlmModelCapabilities("glm-5-turbo").contextWindowOptions, []);
    assert.deepEqual(getGlmModelCapabilities("glm-4.7").contextWindowOptions, []);
  });
});
