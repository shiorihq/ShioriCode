import type { ProviderKind } from "contracts";
import { it, assert, vi } from "@effect/vitest";
import { assertFailure } from "@effect/vitest/utils";

import { Effect, Layer, Stream } from "effect";

import { ClaudeAdapter, ClaudeAdapterShape } from "../Services/ClaudeAdapter.ts";
import { CodexAdapter, CodexAdapterShape } from "../Services/CodexAdapter.ts";
import { CursorAdapter, CursorAdapterShape } from "../Services/CursorAdapter.ts";
import { GeminiAdapter, GeminiAdapterShape } from "../Services/GeminiAdapter.ts";
import { KimiCodeAdapter, KimiCodeAdapterShape } from "../Services/KimiCodeAdapter.ts";
import { ShioriAdapter, ShioriAdapterShape } from "../Services/ShioriAdapter.ts";
import { ProviderAdapterRegistry } from "../Services/ProviderAdapterRegistry.ts";
import { ProviderAdapterRegistryLive } from "./ProviderAdapterRegistry.ts";
import { ProviderUnsupportedError } from "../Errors.ts";
import * as NodeServices from "@effect/platform-node/NodeServices";

const fakeShioriAdapter: ShioriAdapterShape = {
  provider: "shiori",
  capabilities: {
    sessionModelSwitch: "restart-session",
    recovery: { supportsResumeCursor: false, supportsAdoptActiveSession: false },
    observability: { emitsStructuredSessionExit: false, emitsRuntimeDiagnostics: false },
  },
  startSession: vi.fn(),
  sendTurn: vi.fn(),
  interruptTurn: vi.fn(),
  respondToRequest: vi.fn(),
  respondToUserInput: vi.fn(),
  stopSession: vi.fn(),
  listSessions: vi.fn(),
  hasSession: vi.fn(),
  readThread: vi.fn(),
  rollbackThread: vi.fn(),
  stopAll: vi.fn(),
  streamEvents: Stream.empty,
};

const fakeCodexAdapter: CodexAdapterShape = {
  provider: "codex",
  capabilities: {
    sessionModelSwitch: "in-session",
    recovery: { supportsResumeCursor: false, supportsAdoptActiveSession: false },
    observability: { emitsStructuredSessionExit: false, emitsRuntimeDiagnostics: false },
  },
  startSession: vi.fn(),
  sendTurn: vi.fn(),
  interruptTurn: vi.fn(),
  respondToRequest: vi.fn(),
  respondToUserInput: vi.fn(),
  stopSession: vi.fn(),
  listSessions: vi.fn(),
  hasSession: vi.fn(),
  readThread: vi.fn(),
  rollbackThread: vi.fn(),
  readUsage: vi.fn(),
  stopAll: vi.fn(),
  streamEvents: Stream.empty,
};

const fakeKimiCodeAdapter: KimiCodeAdapterShape = {
  provider: "kimiCode",
  capabilities: {
    sessionModelSwitch: "restart-session",
    recovery: { supportsResumeCursor: false, supportsAdoptActiveSession: false },
    observability: { emitsStructuredSessionExit: false, emitsRuntimeDiagnostics: false },
  },
  startSession: vi.fn(),
  sendTurn: vi.fn(),
  interruptTurn: vi.fn(),
  respondToRequest: vi.fn(),
  respondToUserInput: vi.fn(),
  stopSession: vi.fn(),
  listSessions: vi.fn(),
  hasSession: vi.fn(),
  readThread: vi.fn(),
  rollbackThread: vi.fn(),
  stopAll: vi.fn(),
  streamEvents: Stream.empty,
};

const fakeGeminiAdapter: GeminiAdapterShape = {
  provider: "gemini",
  capabilities: {
    sessionModelSwitch: "restart-session",
    recovery: { supportsResumeCursor: false, supportsAdoptActiveSession: true },
    observability: { emitsStructuredSessionExit: true, emitsRuntimeDiagnostics: true },
  },
  startSession: vi.fn(),
  sendTurn: vi.fn(),
  interruptTurn: vi.fn(),
  respondToRequest: vi.fn(),
  respondToUserInput: vi.fn(),
  stopSession: vi.fn(),
  listSessions: vi.fn(),
  hasSession: vi.fn(),
  readThread: vi.fn(),
  rollbackThread: vi.fn(),
  stopAll: vi.fn(),
  streamEvents: Stream.empty,
};

const fakeCursorAdapter: CursorAdapterShape = {
  provider: "cursor",
  capabilities: {
    sessionModelSwitch: "restart-session",
    recovery: { supportsResumeCursor: true, supportsAdoptActiveSession: true },
    observability: { emitsStructuredSessionExit: true, emitsRuntimeDiagnostics: true },
  },
  startSession: vi.fn(),
  sendTurn: vi.fn(),
  interruptTurn: vi.fn(),
  respondToRequest: vi.fn(),
  respondToUserInput: vi.fn(),
  stopSession: vi.fn(),
  listSessions: vi.fn(),
  hasSession: vi.fn(),
  readThread: vi.fn(),
  rollbackThread: vi.fn(),
  stopAll: vi.fn(),
  streamEvents: Stream.empty,
};

const fakeClaudeAdapter: ClaudeAdapterShape = {
  provider: "claudeAgent",
  capabilities: {
    sessionModelSwitch: "in-session",
    recovery: { supportsResumeCursor: false, supportsAdoptActiveSession: false },
    observability: { emitsStructuredSessionExit: false, emitsRuntimeDiagnostics: false },
  },
  startSession: vi.fn(),
  sendTurn: vi.fn(),
  interruptTurn: vi.fn(),
  respondToRequest: vi.fn(),
  respondToUserInput: vi.fn(),
  stopSession: vi.fn(),
  listSessions: vi.fn(),
  hasSession: vi.fn(),
  readThread: vi.fn(),
  rollbackThread: vi.fn(),
  readUsage: vi.fn(),
  stopAll: vi.fn(),
  streamEvents: Stream.empty,
};

const layer = it.layer(
  Layer.mergeAll(
    Layer.provide(
      ProviderAdapterRegistryLive,
      Layer.mergeAll(
        Layer.succeed(ShioriAdapter, fakeShioriAdapter),
        Layer.succeed(KimiCodeAdapter, fakeKimiCodeAdapter),
        Layer.succeed(GeminiAdapter, fakeGeminiAdapter),
        Layer.succeed(CursorAdapter, fakeCursorAdapter),
        Layer.succeed(CodexAdapter, fakeCodexAdapter),
        Layer.succeed(ClaudeAdapter, fakeClaudeAdapter),
      ),
    ),
    NodeServices.layer,
  ),
);

layer("ProviderAdapterRegistryLive", (it) => {
  it.effect("resolves a registered provider adapter", () =>
    Effect.gen(function* () {
      const registry = yield* ProviderAdapterRegistry;
      const shiori = yield* registry.getByProvider("shiori");
      const kimiCode = yield* registry.getByProvider("kimiCode");
      const gemini = yield* registry.getByProvider("gemini");
      const cursor = yield* registry.getByProvider("cursor");
      const codex = yield* registry.getByProvider("codex");
      const claude = yield* registry.getByProvider("claudeAgent");
      assert.equal(shiori, fakeShioriAdapter);
      assert.equal(kimiCode, fakeKimiCodeAdapter);
      assert.equal(gemini, fakeGeminiAdapter);
      assert.equal(cursor, fakeCursorAdapter);
      assert.equal(codex, fakeCodexAdapter);
      assert.equal(claude, fakeClaudeAdapter);

      const providers = yield* registry.listProviders();
      assert.deepEqual(providers, [
        "shiori",
        "kimiCode",
        "gemini",
        "cursor",
        "codex",
        "claudeAgent",
      ]);
    }),
  );

  it.effect("fails with ProviderUnsupportedError for unknown providers", () =>
    Effect.gen(function* () {
      const registry = yield* ProviderAdapterRegistry;
      const adapter = yield* registry.getByProvider("unknown" as ProviderKind).pipe(Effect.result);
      assertFailure(adapter, new ProviderUnsupportedError({ provider: "unknown" }));
    }),
  );
});
