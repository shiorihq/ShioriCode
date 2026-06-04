import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it, vi } from "@effect/vitest";
import {
  LocalAgentConfig,
  Step,
  StepSource,
  StepStatus,
  StepTarget,
  StepType,
} from "google-antigravity";
import type { Agent } from "google-antigravity";
import { ThreadId } from "contracts";
import { Effect, Layer } from "effect";

import { ServerConfig } from "../../config.ts";
import { ServerSettingsService } from "../../serverSettings.ts";
import { GeminiAdapter } from "../Services/GeminiAdapter.ts";
import { makeGeminiAdapterLive } from "./GeminiAdapter.ts";

function makeFakeAgent(
  config: LocalAgentConfig,
  fallbackConversationId: string,
  options?: { readonly omitAgentConversationId?: boolean },
): Agent {
  const conversationId = config.conversationId ?? fallbackConversationId;
  const fake = {
    ...(options?.omitAgentConversationId ? {} : { conversationId }),
    conversation: {
      send: vi.fn(async () => undefined),
      receiveSteps: async function* () {
        yield new Step({
          id: `${conversationId}:assistant`,
          stepIndex: 1,
          type: StepType.TEXT_RESPONSE,
          source: StepSource.MODEL,
          target: StepTarget.USER,
          status: StepStatus.DONE,
          content: "ok",
          contentDelta: "ok",
        });
      },
      cancel: vi.fn(async () => undefined),
    },
    stop: vi.fn(async () => undefined),
  };
  return fake as unknown as Agent;
}

function makeHarness(options?: {
  readonly settings?: Record<string, unknown>;
  readonly omitAgentConversationId?: boolean;
}) {
  const configs: LocalAgentConfig[] = [];
  let sessionIndex = 0;
  const startAgent = vi.fn(async (config: LocalAgentConfig) => {
    configs.push(config);
    sessionIndex += 1;
    return makeFakeAgent(
      config,
      `antigravity-session-${sessionIndex}`,
      options?.omitAgentConversationId ? { omitAgentConversationId: true } : undefined,
    );
  });
  const layer = makeGeminiAdapterLive({ startAgent }).pipe(
    Layer.provideMerge(ServerConfig.layerTest(process.cwd(), process.cwd())),
    Layer.provideMerge(
      ServerSettingsService.layerTest({
        providers: {
          gemini: {
            binaryPath: "",
            googleCloudProject: "test-project",
          },
        },
        ...options?.settings,
      }),
    ),
    Layer.provideMerge(NodeServices.layer),
  );
  return { layer, configs, startAgent };
}

function policyNames(config: LocalAgentConfig | undefined): ReadonlyArray<string> {
  return (config?.policies ?? []).map((entry) =>
    typeof entry === "object" && entry !== null && "name" in entry
      ? String((entry as { name: unknown }).name)
      : "",
  );
}

function mcpServerByName(config: LocalAgentConfig | undefined, name: string) {
  return config?.mcpServers.find((server) => server.name === name);
}

describe("GeminiAdapterLive", () => {
  it.effect("passes resumeCursor through as the Antigravity conversation id", () => {
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
          conversationId: "antigravity-existing",
        },
      });

      assert.strictEqual(harness.configs.length, 1);
      assert.strictEqual(harness.configs[0]?.conversationId, "antigravity-existing");
      assert.deepStrictEqual(session.resumeCursor, {
        schemaVersion: 1,
        conversationId: "antigravity-existing",
      });
      assert.strictEqual(adapter.capabilities.recovery.supportsResumeCursor, true);
    }).pipe(Effect.provide(harness.layer));
  });

  it.effect("maps runtime mode into Antigravity SDK policies", () => {
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
        threadId: ThreadId.makeUnsafe("thread-gemini-full-access"),
        provider: "gemini",
        cwd: process.cwd(),
        runtimeMode: "full-access",
      });

      assert.strictEqual(policyNames(harness.configs[0]).includes("shiori_approval"), true);
      assert.strictEqual(policyNames(harness.configs[1]).includes("allow_all"), true);
    }).pipe(Effect.provide(harness.layer));
  });

  it.effect("restarts the Antigravity session when the requested model changes", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const adapter = yield* GeminiAdapter;
      const threadId = ThreadId.makeUnsafe("thread-gemini-model-switch");

      yield* adapter.startSession({
        threadId,
        provider: "gemini",
        cwd: process.cwd(),
        runtimeMode: "full-access",
        modelSelection: { provider: "gemini", model: "auto" },
      });
      yield* adapter.sendTurn({
        threadId,
        input: "Use a different model",
        modelSelection: { provider: "gemini", model: "gemini-3.5-flash" },
      });

      assert.strictEqual(harness.startAgent.mock.calls.length, 2);
      assert.strictEqual(harness.configs[0]?.model, undefined);
      assert.strictEqual(harness.configs[1]?.model, "gemini-3.5-flash");
      assert.strictEqual(harness.configs[1]?.conversationId, "antigravity-session-1");
    }).pipe(Effect.provide(harness.layer));
  });

  it.effect("keeps a resumed Antigravity conversation id after a completed turn", () => {
    const harness = makeHarness({ omitAgentConversationId: true });
    return Effect.gen(function* () {
      const adapter = yield* GeminiAdapter;
      const threadId = ThreadId.makeUnsafe("thread-gemini-resume-turn");

      yield* adapter.startSession({
        threadId,
        provider: "gemini",
        cwd: process.cwd(),
        runtimeMode: "full-access",
        resumeCursor: {
          schemaVersion: 1,
          conversationId: "antigravity-existing",
        },
      });
      yield* adapter.sendTurn({
        threadId,
        input: "Keep the existing Antigravity conversation id",
      });
      yield* Effect.promise(() => new Promise<void>((resolve) => setTimeout(resolve, 20)));

      const [session] = yield* adapter.listSessions();
      assert.deepStrictEqual(session?.resumeCursor, {
        schemaVersion: 1,
        conversationId: "antigravity-existing",
      });
    }).pipe(Effect.provide(harness.layer));
  });

  it.effect("exposes approval-required Computer Use MCP to Antigravity when policy can ask", () => {
    const harness = makeHarness({
      settings: {
        browserUse: { enabled: false },
        computerUse: { enabled: true, requireApproval: true, shareWithProviders: true },
        mcpServers: { servers: [] },
      },
    });
    return Effect.gen(function* () {
      const adapter = yield* GeminiAdapter;

      yield* adapter.startSession({
        threadId: ThreadId.makeUnsafe("thread-gemini-computer-approval"),
        provider: "gemini",
        cwd: process.cwd(),
        runtimeMode: "approval-required",
      });

      const computerServer = mcpServerByName(harness.configs[0], "shiori-computer-use");
      assert.ok(computerServer);
      if (
        typeof (computerServer as { readonly command?: unknown }).command !== "string" ||
        !Array.isArray((computerServer as { readonly args?: unknown }).args)
      ) {
        assert.fail("Expected shiori-computer-use to be a stdio MCP server.");
      }
      const stdioServer = computerServer as {
        readonly command: string;
        readonly args: ReadonlyArray<string>;
      };
      assert.strictEqual(stdioServer.command, "/usr/bin/env");
      assert.deepStrictEqual(stdioServer.args.slice(0, 2), [
        "SHIORICODE_COMPUTER_USE_ENABLED=1",
        "SHIORICODE_COMPUTER_USE_REQUIRE_APPROVAL=1",
      ]);
      assert.strictEqual(stdioServer.args.includes("computer-use-mcp"), true);
      assert.strictEqual(policyNames(harness.configs[0]).includes("shiori_approval"), true);
    }).pipe(Effect.provide(harness.layer));
  });

  it.effect(
    "hides approval-required Computer Use MCP from Antigravity full-access sessions",
    () => {
      const harness = makeHarness({
        settings: {
          browserUse: { enabled: false },
          computerUse: { enabled: true, requireApproval: true },
          mcpServers: { servers: [] },
        },
      });
      return Effect.gen(function* () {
        const adapter = yield* GeminiAdapter;

        yield* adapter.startSession({
          threadId: ThreadId.makeUnsafe("thread-gemini-computer-full-access"),
          provider: "gemini",
          cwd: process.cwd(),
          runtimeMode: "full-access",
        });

        assert.strictEqual(mcpServerByName(harness.configs[0], "shiori-computer-use"), undefined);
        assert.strictEqual(policyNames(harness.configs[0]).includes("allow_all"), true);
      }).pipe(Effect.provide(harness.layer));
    },
  );
});
