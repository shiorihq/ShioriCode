import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it, vi } from "@effect/vitest";
import { ThreadId } from "contracts";
import { Effect, Layer, Stream } from "effect";
import type * as EffectAcpErrors from "effect-acp/errors";
import type * as EffectAcpSchema from "effect-acp/schema";

import { ServerConfig } from "../../config.ts";
import { ServerSettingsService } from "../../serverSettings.ts";
import type { GeminiAcpRuntimeInput } from "../acp/GeminiAcpSupport.ts";
import type { AcpSessionRuntimeShape } from "../acp/AcpSessionRuntime.ts";
import { GeminiAdapter } from "../Services/GeminiAdapter.ts";
import { makeGeminiAdapterLive } from "./GeminiAdapter.ts";

function makeFakeAcpRuntime(
  input: GeminiAcpRuntimeInput,
  fallbackSessionId: string,
): AcpSessionRuntimeShape {
  const sessionId = input.resumeSessionId ?? fallbackSessionId;
  return {
    handleRequestPermission: vi.fn(() => Effect.void),
    handleElicitation: vi.fn(() => Effect.void),
    handleReadTextFile: vi.fn(() => Effect.void),
    handleWriteTextFile: vi.fn(() => Effect.void),
    handleCreateTerminal: vi.fn(() => Effect.void),
    handleTerminalOutput: vi.fn(() => Effect.void),
    handleTerminalWaitForExit: vi.fn(() => Effect.void),
    handleTerminalKill: vi.fn(() => Effect.void),
    handleTerminalRelease: vi.fn(() => Effect.void),
    handleSessionUpdate: vi.fn(() => Effect.void),
    handleElicitationComplete: vi.fn(() => Effect.void),
    handleUnknownExtRequest: vi.fn(() => Effect.void),
    handleUnknownExtNotification: vi.fn(() => Effect.void),
    handleExtRequest: vi.fn(() => Effect.void),
    handleExtNotification: vi.fn(() => Effect.void),
    start: () =>
      Effect.succeed({
        sessionId,
        initializeResult: {
          protocolVersion: 1,
          agentCapabilities: {},
          agentInfo: {
            name: "fake-gemini",
            version: "0.0.0",
          },
        } as EffectAcpSchema.InitializeResponse,
        sessionSetupResult: {
          sessionId,
        } as EffectAcpSchema.NewSessionResponse,
        modelConfigId: undefined,
      }),
    getEvents: () => Stream.empty,
    getModeState: Effect.succeed(undefined),
    getConfigOptions: Effect.succeed([]),
    prompt: vi.fn(() =>
      Effect.succeed({
        stopReason: "end_turn",
      } as EffectAcpSchema.PromptResponse),
    ),
    cancel: Effect.void,
    setMode: vi.fn(() => Effect.succeed({} as EffectAcpSchema.SetSessionModeResponse)),
    setConfigOption: vi.fn(() =>
      Effect.succeed({ configOptions: [] } as EffectAcpSchema.SetSessionConfigOptionResponse),
    ),
    setModel: vi.fn(() => Effect.void),
    request: vi.fn(() => Effect.succeed({})),
    notify: vi.fn(() => Effect.void),
  };
}

function makeHarness() {
  const runtimeInputs: GeminiAcpRuntimeInput[] = [];
  let sessionIndex = 0;
  const makeAcpRuntime = vi.fn(
    (
      input: GeminiAcpRuntimeInput,
    ): Effect.Effect<AcpSessionRuntimeShape, EffectAcpErrors.AcpError> =>
      Effect.sync(() => {
        runtimeInputs.push(input);
        sessionIndex += 1;
        return makeFakeAcpRuntime(input, `gemini-session-${sessionIndex}`);
      }),
  );
  const layer = makeGeminiAdapterLive({ makeAcpRuntime }).pipe(
    Layer.provideMerge(ServerConfig.layerTest(process.cwd(), process.cwd())),
    Layer.provideMerge(
      ServerSettingsService.layerTest({
        providers: {
          gemini: {
            acpFlag: "--acp",
          },
        },
      }),
    ),
    Layer.provideMerge(NodeServices.layer),
  );
  return { layer, runtimeInputs, makeAcpRuntime };
}

describe("GeminiAdapterLive", () => {
  it.effect("passes resumeCursor through as the ACP session/load id", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const adapter = yield* GeminiAdapter;
      const session = yield* adapter.startSession({
        threadId: ThreadId.makeUnsafe("thread-gemini-resume"),
        provider: "gemini",
        cwd: process.cwd(),
        runtimeMode: "approval-required",
        resumeCursor: {
          schemaVersion: 1,
          sessionId: "acp-session-existing",
        },
      });

      assert.strictEqual(harness.runtimeInputs.length, 1);
      assert.strictEqual(harness.runtimeInputs[0]?.resumeSessionId, "acp-session-existing");
      assert.deepStrictEqual(session.resumeCursor, {
        schemaVersion: 1,
        sessionId: "acp-session-existing",
      });
      assert.strictEqual(adapter.capabilities.recovery.supportsResumeCursor, true);
    }).pipe(Effect.provide(harness.layer));
  });

  it.effect("maps runtime policy into Gemini approval-mode spawn inputs", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const adapter = yield* GeminiAdapter;

      yield* adapter.startSession({
        threadId: ThreadId.makeUnsafe("thread-gemini-approval-required"),
        provider: "gemini",
        cwd: process.cwd(),
        runtimeMode: "approval-required",
      });
      yield* adapter.startSession({
        threadId: ThreadId.makeUnsafe("thread-gemini-yolo"),
        provider: "gemini",
        cwd: process.cwd(),
        runtimeMode: "full-access",
      });

      assert.strictEqual(harness.runtimeInputs[0]?.approvalMode, "default");
      assert.strictEqual(harness.runtimeInputs[1]?.approvalMode, "yolo");
    }).pipe(Effect.provide(harness.layer));
  });

  it.effect("restarts with plan approval mode for plan turns and resumes the ACP session", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const adapter = yield* GeminiAdapter;
      const threadId = ThreadId.makeUnsafe("thread-gemini-plan");

      yield* adapter.startSession({
        threadId,
        provider: "gemini",
        cwd: process.cwd(),
        runtimeMode: "full-access",
      });
      yield* adapter.sendTurn({
        threadId,
        input: "Make a plan",
        interactionMode: "plan",
      });

      assert.strictEqual(harness.runtimeInputs.length, 2);
      assert.strictEqual(harness.runtimeInputs[0]?.approvalMode, "yolo");
      assert.strictEqual(harness.runtimeInputs[1]?.approvalMode, "plan");
      assert.strictEqual(harness.runtimeInputs[1]?.resumeSessionId, "gemini-session-1");
    }).pipe(Effect.provide(harness.layer));
  });
});
