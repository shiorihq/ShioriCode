import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it, vi } from "@effect/vitest";
import {
  LocalAgentConfig,
  McpStdioServer,
  Step,
  StepSource,
  StepStatus,
  StepTarget,
  StepType,
  UsageMetadata,
} from "google-antigravity";
import type { Agent } from "google-antigravity";
import { ThreadId } from "contracts";
import { Effect, Layer, Schema } from "effect";

import { ServerConfig } from "../../config.ts";
import { ServerSettingsService } from "../../serverSettings.ts";
import { ProviderAdapterProcessError } from "../Errors.ts";
import { GeminiAdapter } from "../Services/GeminiAdapter.ts";
import { makeGeminiAdapterLive, normalizeGeminiStepUsage } from "./GeminiAdapter.ts";

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
  readonly startAgent?: (config: LocalAgentConfig, callIndex: number) => Promise<Agent>;
  readonly verifyGoalMcpServer?: NonNullable<
    Parameters<typeof makeGeminiAdapterLive>[0]
  >["verifyGoalMcpServer"];
}) {
  const configs: LocalAgentConfig[] = [];
  const agents: Agent[] = [];
  let sessionIndex = 0;
  const startAgent = vi.fn(async (config: LocalAgentConfig) => {
    configs.push(config);
    sessionIndex += 1;
    const agent = options?.startAgent
      ? await options.startAgent(config, sessionIndex)
      : makeFakeAgent(
          config,
          `antigravity-session-${sessionIndex}`,
          options?.omitAgentConversationId ? { omitAgentConversationId: true } : undefined,
        );
    agents.push(agent);
    return agent;
  });
  const layer = makeGeminiAdapterLive({
    startAgent,
    verifyGoalMcpServer: options?.verifyGoalMcpServer ?? (() => Promise.resolve()),
  }).pipe(
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
  return { layer, configs, startAgent, agents };
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
  it.effect("replaces a ready session only after its successor starts", () => {
    const harness = makeHarness();
    const threadId = ThreadId.makeUnsafe("thread-gemini-replacement");
    return Effect.gen(function* () {
      const adapter = yield* GeminiAdapter;
      const first = yield* adapter.startSession({
        threadId,
        provider: "gemini",
        cwd: process.cwd(),
        runtimeMode: "full-access",
      });
      const second = yield* adapter.startSession({
        threadId,
        provider: "gemini",
        cwd: process.cwd(),
        runtimeMode: "full-access",
      });

      assert.notEqual(JSON.stringify(first.resumeCursor), JSON.stringify(second.resumeCursor));
      assert.strictEqual(
        (harness.agents[0] as unknown as { stop: ReturnType<typeof vi.fn> }).stop.mock.calls.length,
        1,
      );
      assert.strictEqual((yield* adapter.listSessions()).length, 1);
    }).pipe(Effect.provide(harness.layer));
  });

  it.effect("preserves a ready session when its replacement fails to start", () => {
    const harness = makeHarness({
      startAgent: async (config, callIndex) => {
        if (callIndex === 2) throw new Error("replacement failed");
        return makeFakeAgent(config, "antigravity-stable");
      },
    });
    const threadId = ThreadId.makeUnsafe("thread-gemini-failed-replacement");
    return Effect.gen(function* () {
      const adapter = yield* GeminiAdapter;
      const first = yield* adapter.startSession({
        threadId,
        provider: "gemini",
        cwd: process.cwd(),
        runtimeMode: "full-access",
      });
      yield* adapter
        .startSession({
          threadId,
          provider: "gemini",
          cwd: process.cwd(),
          runtimeMode: "full-access",
        })
        .pipe(Effect.flip);

      assert.deepStrictEqual((yield* adapter.listSessions())[0]?.resumeCursor, first.resumeCursor);
      assert.strictEqual(
        (harness.agents[0] as unknown as { stop: ReturnType<typeof vi.fn> }).stop.mock.calls.length,
        0,
      );
      assert.strictEqual(yield* adapter.hasSession(threadId), true);
    }).pipe(Effect.provide(harness.layer));
  });

  it.effect(
    "fails closed before Agent.start when the exact goal MCP tool contract is invalid",
    () => {
      const harness = makeHarness({
        verifyGoalMcpServer: () =>
          Promise.reject(
            new Error(
              "Required 'shioricode-thread-goal' MCP tool contract mismatch (missing: update_goal).",
            ),
          ),
      });
      return Effect.gen(function* () {
        const adapter = yield* GeminiAdapter;
        const error = yield* adapter
          .startSession({
            threadId: ThreadId.makeUnsafe("thread-gemini-invalid-goal-tools"),
            provider: "gemini",
            cwd: process.cwd(),
            runtimeMode: "full-access",
          })
          .pipe(Effect.flip);

        assert.ok(Schema.is(ProviderAdapterProcessError)(error));
        assert.match(error.detail, /tool contract mismatch.*missing: update_goal/u);
        assert.strictEqual(harness.startAgent.mock.calls.length, 0);
      }).pipe(Effect.provide(harness.layer));
    },
  );

  it("marks Antigravity per-step usage as a processed-token delta", () => {
    const usage = normalizeGeminiStepUsage(
      new Step({
        id: "step-with-usage",
        stepIndex: 1,
        usageMetadata: new UsageMetadata({
          promptTokenCount: 100,
          cachedContentTokenCount: 20,
          candidatesTokenCount: 30,
          thoughtsTokenCount: 7,
          totalTokenCount: 157,
        }),
      }),
    );

    assert.deepStrictEqual(usage, {
      usedTokens: 157,
      totalProcessedTokens: 157,
      processedTokensDelta: 157,
      inputTokens: 100,
      cachedInputTokens: 20,
      outputTokens: 30,
      reasoningOutputTokens: 7,
      lastUsedTokens: 157,
      lastInputTokens: 100,
      lastCachedInputTokens: 20,
      lastOutputTokens: 30,
      lastReasoningOutputTokens: 7,
    });
  });

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
      assert.strictEqual(
        policyNames(harness.configs[0]).includes("shioricode_thread_goal_get"),
        true,
      );
      assert.strictEqual(
        policyNames(harness.configs[0]).includes("shioricode_thread_goal_update"),
        true,
      );
      assert.strictEqual(policyNames(harness.configs[1]).includes("allow_all"), true);
    }).pipe(Effect.provide(harness.layer));
  });

  it.effect("keeps the required thread-goal MCP credentials out of process arguments", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const adapter = yield* GeminiAdapter;

      yield* adapter.startSession({
        threadId: ThreadId.makeUnsafe("thread-gemini-goal-mcp"),
        provider: "gemini",
        cwd: process.cwd(),
        runtimeMode: "approval-required",
      });

      const goalServer = mcpServerByName(harness.configs[0], "shioricode-thread-goal");
      assert.ok(goalServer instanceof McpStdioServer);
      assert.strictEqual(goalServer.command, process.execPath);
      assert.strictEqual(goalServer.args.includes("thread-goal-mcp"), true);
      const capabilityToken = goalServer.env?.SHIORICODE_THREAD_GOAL_CAPABILITY_TOKEN;
      assert.ok(capabilityToken);
      assert.ok(goalServer.env?.SHIORICODE_THREAD_GOAL_CONTROL_URL);
      assert.strictEqual(
        goalServer.args.some((arg) => arg.includes(capabilityToken)),
        false,
      );
      assert.strictEqual(
        goalServer.args.some((arg) => arg.startsWith("SHIORICODE_THREAD_GOAL_")),
        false,
      );
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

  it.effect("exposes Computer Use MCP to Antigravity when enabled", () => {
    const harness = makeHarness({
      settings: {
        browserUse: { enabled: false },
        computerUse: { enabled: true },
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
      const stdioServer = computerServer as McpStdioServer;
      assert.strictEqual(stdioServer.command, process.execPath);
      assert.strictEqual(stdioServer.env?.SHIORICODE_COMPUTER_USE_ENABLED, "1");
      assert.strictEqual(stdioServer.args.includes("SHIORICODE_COMPUTER_USE_ENABLED=1"), false);
      assert.strictEqual(stdioServer.args.includes("computer-use-mcp"), true);
      assert.strictEqual(policyNames(harness.configs[0]).includes("shiori_approval"), true);
    }).pipe(Effect.provide(harness.layer));
  });

  it.effect("exposes Computer Use MCP to Antigravity full-access sessions", () => {
    const harness = makeHarness({
      settings: {
        browserUse: { enabled: false },
        computerUse: { enabled: true },
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

      assert.ok(mcpServerByName(harness.configs[0], "shiori-computer-use"));
      assert.strictEqual(policyNames(harness.configs[0]).includes("allow_all"), true);
    }).pipe(Effect.provide(harness.layer));
  });
});
