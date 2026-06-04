import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import type {
  AgentOptions,
  Run,
  RunOperation,
  RunResult,
  RunStatus,
  SDKAgent,
  SDKMessage,
  SDKUserMessage,
  SendOptions,
} from "@cursor/sdk";
import type { ProviderRuntimeEvent } from "contracts";
import { ThreadId } from "contracts";
import { Effect, Layer, Option } from "effect";
import { vi } from "vitest";

import { ServerConfig } from "../../config.ts";
import { ServerSettingsService } from "../../serverSettings.ts";
import { CursorAdapter } from "../Services/CursorAdapter.ts";
import { makeCursorAdapterLive, parseCursorResume } from "./CursorAdapter.ts";

vi.mock("@cursor/sdk", () => ({
  Agent: {
    create: vi.fn(),
    resume: vi.fn(),
  },
}));

const THREAD_ID = ThreadId.makeUnsafe("thread-cursor-test");

const waitForAdapterFiber = Effect.promise(
  () => new Promise<void>((resolve) => setTimeout(resolve, 0)),
);

class FakeCursorRun implements Run {
  readonly id = "cursor-run-1";
  readonly agentId = "cursor-agent-1";
  readonly createdAt = Date.now();
  status: RunStatus = "running";
  cancelCalls = 0;
  messages: SDKMessage[] = [];
  waitResult: RunResult = { id: this.id, status: "finished" };
  waitPromise: Promise<RunResult> | undefined;
  private resolveWait: ((result: RunResult) => void) | undefined;

  supports(operation: RunOperation): boolean {
    return operation === "stream" || operation === "wait" || operation === "cancel";
  }

  unsupportedReason(_operation: RunOperation): string | undefined {
    return undefined;
  }

  async *stream(): AsyncGenerator<SDKMessage, void> {
    for (const message of this.messages) {
      yield message;
    }
  }

  wait(): Promise<RunResult> {
    return this.waitPromise ?? Promise.resolve(this.waitResult);
  }

  blockWaitUntilCancel(): void {
    this.waitPromise = new Promise((resolve) => {
      this.resolveWait = resolve;
    });
  }

  cancel(): Promise<void> {
    this.cancelCalls += 1;
    this.status = "cancelled";
    this.resolveWait?.({ id: this.id, status: "cancelled" });
    this.resolveWait = undefined;
    return Promise.resolve();
  }

  onDidChangeStatus(_listener: (status: RunStatus) => void): () => void {
    return () => {};
  }

  conversation(): Promise<[]> {
    return Promise.resolve([]);
  }
}

class FakeCursorAgent implements SDKAgent {
  readonly agentId = "cursor-agent-1";
  model = { id: "auto" };
  readonly sendCalls: Array<{ message: string | SDKUserMessage; options?: SendOptions }> = [];
  closeCalls = 0;
  nextRun = new FakeCursorRun();

  send(message: string | SDKUserMessage, options?: SendOptions): Promise<Run> {
    this.sendCalls.push({ message, ...(options ? { options } : {}) });
    return Promise.resolve(this.nextRun);
  }

  close(): void {
    this.closeCalls += 1;
  }

  reload(): Promise<void> {
    return Promise.resolve();
  }

  [Symbol.asyncDispose](): Promise<void> {
    this.close();
    return Promise.resolve();
  }

  listArtifacts(): Promise<[]> {
    return Promise.resolve([]);
  }

  downloadArtifact(_path: string): Promise<Buffer> {
    return Promise.resolve(Buffer.alloc(0));
  }
}

function makeHarness(input?: {
  readonly agent?: FakeCursorAgent;
  readonly events?: Array<ProviderRuntimeEvent>;
  readonly settings?: Parameters<typeof ServerSettingsService.layerTest>[0];
  readonly createAgent?: (options: AgentOptions) => Promise<SDKAgent>;
  readonly resumeAgent?: (agentId: string, options?: Partial<AgentOptions>) => Promise<SDKAgent>;
}) {
  const agent = input?.agent ?? new FakeCursorAgent();
  return makeCursorAdapterLive({
    ...(input?.events
      ? {
          runtimeEventObserver: (event: ProviderRuntimeEvent) =>
            Effect.sync(() => {
              input.events?.push(event);
            }),
        }
      : {}),
    createAgent: input?.createAgent ?? (() => Promise.resolve(agent)),
    resumeAgent: input?.resumeAgent ?? (() => Promise.resolve(agent)),
  }).pipe(
    Layer.provideMerge(ServerConfig.layerTest("/tmp/cursor-adapter-test", { prefix: "cursor" })),
    Layer.provideMerge(ServerSettingsService.layerTest(input?.settings ?? {})),
    Layer.provideMerge(NodeServices.layer),
  );
}

describe("CursorAdapterLive", () => {
  it.effect("starts a Cursor SDK session and persists an agent resume cursor", () => {
    const agent = new FakeCursorAgent();
    const createCalls: AgentOptions[] = [];
    return Effect.gen(function* () {
      const adapter = yield* CursorAdapter;
      const session = yield* adapter.startSession({
        threadId: THREAD_ID,
        provider: "cursor",
        cwd: "/tmp/cursor-adapter-test",
        runtimeMode: "full-access",
      });

      assert.equal(session.provider, "cursor");
      assert.deepInclude(session.resumeCursor as Record<string, unknown>, {
        provider: "cursor",
        agentId: agent.agentId,
      });
    }).pipe(
      Effect.provide(
        makeHarness({
          agent,
          createAgent: (options) => {
            createCalls.push(options);
            return Promise.resolve(agent);
          },
        }),
      ),
      Effect.scoped,
    );
  });

  it.effect("passes built-in Computer Use MCP to Cursor when approvals are not required", () => {
    const agent = new FakeCursorAgent();
    const createCalls: AgentOptions[] = [];
    return Effect.gen(function* () {
      const adapter = yield* CursorAdapter;
      yield* adapter.startSession({
        threadId: THREAD_ID,
        provider: "cursor",
        cwd: "/tmp/cursor-adapter-test",
        runtimeMode: "full-access",
      });

      const computerServer = createCalls[0]?.mcpServers?.["shioricode-computer"];
      assert.ok(computerServer);
      assert.equal(computerServer.type, "stdio");
      if (computerServer.type !== "stdio") {
        assert.fail(`Expected stdio computer MCP server, got ${computerServer.type}`);
      }
      assert.equal(computerServer.env?.SHIORICODE_COMPUTER_USE_ENABLED, "1");
      assert.equal(computerServer.env?.SHIORICODE_COMPUTER_USE_REQUIRE_APPROVAL, "0");
      assert.equal(computerServer.env?.SHIORICODE_COMPUTER_USE_APPROVED_APP_BUNDLE_IDS, "[]");
      assert.equal(computerServer.args?.includes("computer-use-mcp"), true);
    }).pipe(
      Effect.provide(
        makeHarness({
          agent,
          settings: {
            browserUse: { enabled: false },
            computerUse: { enabled: true, requireApproval: false, shareWithProviders: true },
            mcpServers: { servers: [] },
          },
          createAgent: (options) => {
            createCalls.push(options);
            return Promise.resolve(agent);
          },
        }),
      ),
      Effect.scoped,
    );
  });

  it.effect("passes approval-required Computer Use MCP to Cursor approval runtimes", () => {
    const agent = new FakeCursorAgent();
    const createCalls: AgentOptions[] = [];
    return Effect.gen(function* () {
      const adapter = yield* CursorAdapter;
      yield* adapter.startSession({
        threadId: THREAD_ID,
        provider: "cursor",
        cwd: "/tmp/cursor-adapter-test",
        runtimeMode: "approval-required",
      });

      const computerServer = createCalls[0]?.mcpServers?.["shioricode-computer"];
      assert.ok(computerServer);
      assert.equal(computerServer.type, "stdio");
      if (computerServer.type !== "stdio") {
        assert.fail(`Expected stdio computer MCP server, got ${computerServer.type}`);
      }
      assert.equal(computerServer.env?.SHIORICODE_COMPUTER_USE_ENABLED, "1");
      assert.equal(computerServer.env?.SHIORICODE_COMPUTER_USE_REQUIRE_APPROVAL, "1");
      assert.equal(computerServer.args?.includes("computer-use-mcp"), true);
    }).pipe(
      Effect.provide(
        makeHarness({
          agent,
          settings: {
            browserUse: { enabled: false },
            computerUse: { enabled: true, requireApproval: true, shareWithProviders: true },
            mcpServers: { servers: [] },
          },
          createAgent: (options) => {
            createCalls.push(options);
            return Promise.resolve(agent);
          },
        }),
      ),
      Effect.scoped,
    );
  });

  it.effect("streams SDK assistant messages into content deltas and completes the turn", () => {
    const agent = new FakeCursorAgent();
    const events: ProviderRuntimeEvent[] = [];
    agent.nextRun.messages = [
      {
        type: "assistant",
        agent_id: agent.agentId,
        run_id: agent.nextRun.id,
        message: {
          role: "assistant",
          content: [{ type: "text", text: "hello from cursor" }],
        },
      },
    ];

    return Effect.gen(function* () {
      const adapter = yield* CursorAdapter;
      const started = yield* adapter
        .startSession({
          threadId: THREAD_ID,
          provider: "cursor",
          cwd: "/tmp/cursor-adapter-test",
          runtimeMode: "full-access",
        })
        .pipe(Effect.timeoutOption("2 seconds"));
      if (Option.isNone(started)) {
        assert.fail("startSession hung");
      }
      const sent = yield* adapter
        .sendTurn({ threadId: THREAD_ID, input: "hello" })
        .pipe(Effect.timeoutOption("2 seconds"));
      if (Option.isNone(sent)) {
        assert.fail("sendTurn hung");
      }

      yield* waitForAdapterFiber;
      const delta = events.find((event) => event.type === "content.delta");
      const completed = events.find((event) => event.type === "turn.completed");
      if (!delta || !completed) {
        assert.fail("Expected content.delta and turn.completed events");
      }
      assert.equal(delta.payload.delta, "hello from cursor");
      assert.deepInclude(completed.payload, { state: "completed" });
    }).pipe(Effect.provide(makeHarness({ agent, events })), Effect.scoped);
  });

  it.effect("cancels the active SDK run when interrupted", () => {
    const agent = new FakeCursorAgent();
    const events: ProviderRuntimeEvent[] = [];
    agent.nextRun.blockWaitUntilCancel();

    return Effect.gen(function* () {
      const adapter = yield* CursorAdapter;
      const started = yield* adapter
        .startSession({
          threadId: THREAD_ID,
          provider: "cursor",
          cwd: "/tmp/cursor-adapter-test",
          runtimeMode: "approval-required",
        })
        .pipe(Effect.timeoutOption("2 seconds"));
      if (Option.isNone(started)) {
        assert.fail("startSession hung");
      }
      const sent = yield* adapter
        .sendTurn({ threadId: THREAD_ID, input: "hello" })
        .pipe(Effect.timeoutOption("2 seconds"));
      if (Option.isNone(sent)) {
        assert.fail("sendTurn hung");
      }
      yield* adapter.interruptTurn(THREAD_ID);

      yield* waitForAdapterFiber;
      const completed = events.find((event) => event.type === "turn.completed");
      if (!completed) {
        assert.fail("Expected a turn.completed event");
      }
      assert.deepInclude(completed.payload, { state: "cancelled" });
      assert.equal(agent.nextRun.cancelCalls, 1);
    }).pipe(Effect.provide(makeHarness({ agent, events })), Effect.scoped);
  });

  it.effect("resumes existing Cursor SDK agents from v1 and v2 cursors", () => {
    const agent = new FakeCursorAgent();
    const resumedAgentIds: string[] = [];
    return Effect.gen(function* () {
      const adapter = yield* CursorAdapter;
      yield* adapter.startSession({
        threadId: THREAD_ID,
        provider: "cursor",
        cwd: "/tmp/cursor-adapter-test",
        runtimeMode: "full-access",
        resumeCursor: { schemaVersion: 1, sessionId: "old-agent" },
      });

      assert.deepEqual(resumedAgentIds, ["old-agent"]);
    }).pipe(
      Effect.provide(
        makeHarness({
          agent,
          resumeAgent: (agentId) => {
            resumedAgentIds.push(agentId);
            return Promise.resolve(agent);
          },
        }),
      ),
      Effect.scoped,
    );
  });

  it("parses v1 and v2 resume cursors and returns diagnostics for invalid input", () => {
    assert.deepStrictEqual(parseCursorResume({ schemaVersion: 1, sessionId: "old" }), {
      agentId: "old",
      sessionId: "old",
    });
    assert.deepStrictEqual(
      parseCursorResume({ schemaVersion: 2, provider: "cursor", agentId: "new" }),
      {
        agentId: "new",
        sessionId: "new",
      },
    );
    assert.match(
      parseCursorResume({ schemaVersion: 99, agentId: "future" })?.diagnostic ?? "",
      /unsupported/u,
    );
  });
});
