import { EventEmitter } from "node:events";
import { Readable } from "node:stream";
import { HookRunner } from "../../hooks/hook-runner.js";
import { ToolRunner } from "../../tools/tool-runner.js";
import { LocalConnection } from "./local-connection.js";

class AsyncQueue<T> {
  #items: T[] = [];
  #waiters: Array<(value: T) => void> = [];

  push(item: T): void {
    const waiter = this.#waiters.shift();
    if (waiter) {
      waiter(item);
      return;
    }
    this.#items.push(item);
  }

  async shift(timeoutMs?: number): Promise<T> {
    if (this.#items.length) {
      return this.#items.shift() as T;
    }
    return await new Promise<T>((resolve, reject) => {
      let timeout: ReturnType<typeof setTimeout> | undefined;
      if (timeoutMs !== undefined) {
        timeout = setTimeout(() => reject(new Error(`Timed out after ${timeoutMs}ms`)), timeoutMs);
      }
      this.#waiters.push((value) => {
        if (timeout) {
          clearTimeout(timeout);
        }
        resolve(value);
      });
    });
  }
}

type WebSocketMessageEvent = MessageEvent<string>;

export class TestWebSocket extends EventTarget {
  #incomingQueue = new AsyncQueue<string | undefined>();
  sentMessages: string[] = [];
  sentQueue = new AsyncQueue<string>();
  readyState: number = WebSocket.OPEN;

  send(message: string): void {
    this.sentMessages.push(message);
    this.sentQueue.push(message);
  }

  putEvent(event: Record<string, unknown>): void {
    const data = JSON.stringify(event);
    this.#incomingQueue.push(data);
    this.dispatchEvent(
      new MessageEvent("message", {
        data,
      }) as WebSocketMessageEvent,
    );
  }

  close(): void {
    this.readyState = WebSocket.CLOSED;
    this.#incomingQueue.push(undefined);
    this.dispatchEvent(new CloseEvent("close"));
  }

  async nextSent(timeoutMs?: number): Promise<string> {
    return await this.sentQueue.shift(timeoutMs);
  }

  async *[Symbol.asyncIterator](): AsyncIterator<string> {
    while (true) {
      const next = await this.#incomingQueue.shift();
      if (next === undefined) {
        return;
      }
      yield next;
    }
  }
}

class FakeProcess extends EventEmitter {
  stdin = {
    end: () => {
      this.exitCode = 0;
      this.emit("exit", 0, null);
    },
  };
  stderr = new Readable({
    read() {},
  });
  killed = false;
  exitCode: number | null = null;

  kill(): boolean {
    this.killed = true;
    this.exitCode = 0;
    this.emit("exit", 0, null);
    return true;
  }

  override once(eventName: string | symbol, listener: (...args: any[]) => void): this {
    if (eventName === "exit" && this.exitCode !== null) {
      queueMicrotask(() => listener(this.exitCode, null));
      return this;
    }
    return super.once(eventName, listener);
  }
}

export type TestLocalHarnessInit = {
  process?: unknown;
  ws?: TestWebSocket;
  toolRunner?: ToolRunner;
  tool_runner?: ToolRunner;
  hookRunner?: HookRunner;
  hook_runner?: HookRunner;
  conversationId?: string;
  conversation_id?: string;
};

export class TestLocalHarness {
  ws: TestWebSocket;
  conn: LocalConnection;

  constructor(init: TestLocalHarnessInit = {}) {
    this.ws = init.ws ?? new TestWebSocket();
    this.conn = new LocalConnection({
      process: (init.process ?? new FakeProcess()) as never,
      ws: this.ws as never,
      toolRunner: init.toolRunner ?? init.tool_runner,
      hookRunner: init.hookRunner ?? init.hook_runner,
      conversationId: init.conversationId ?? init.conversation_id,
    });
  }

  async disconnectSdk(): Promise<void> {
    await this.conn.disconnect();
  }

  disconnect_sdk(): Promise<void> {
    return this.disconnectSdk();
  }

  async closeFromHarnessSide(): Promise<void> {
    this.ws.close();
  }

  close_from_harness_side(): Promise<void> {
    return this.closeFromHarnessSide();
  }

  async waitForResponse(timeout = 10_000): Promise<Record<string, unknown>> {
    return JSON.parse(await this.ws.nextSent(timeout)) as Record<string, unknown>;
  }

  wait_for_response(timeout = 10_000): Promise<Record<string, unknown>> {
    return this.waitForResponse(timeout);
  }

  async waitForEvent(event: Promise<unknown>, timeout = 10_000): Promise<void> {
    await Promise.race([
      event,
      new Promise((_resolve, reject) =>
        setTimeout(() => reject(new Error(`Timed out after ${timeout}ms`)), timeout),
      ),
    ]);
  }

  wait_for_event(event: Promise<unknown>, timeout = 10_000): Promise<void> {
    return this.waitForEvent(event, timeout);
  }

  async sendEvent(event: Record<string, unknown>): Promise<void> {
    this.ws.putEvent(event);
  }

  send_event(event: Record<string, unknown>): Promise<void> {
    return this.sendEvent(event);
  }

  async sendToolCall(id: string, name: string, argumentsJson: string): Promise<void> {
    await this.sendEvent({
      toolCall: {
        id,
        name,
        argumentsJson,
      },
    });
  }

  send_tool_call(id: string, name: string, arguments_json: string): Promise<void> {
    return this.sendToolCall(id, name, arguments_json);
  }

  async sendToolConfirmationRequest(
    trajectoryId: string,
    stepIndex: number,
    fields: Record<string, unknown> = {},
  ): Promise<void> {
    await this.sendEvent({
      stepUpdate: {
        trajectoryId,
        stepIndex,
        state: "STATE_WAITING_FOR_USER",
        toolConfirmationRequest: {},
        ...fields,
      },
    });
  }

  send_tool_confirmation_request(
    trajectory_id: string,
    step_index: number,
    fields: Record<string, unknown> = {},
  ): Promise<void> {
    return this.sendToolConfirmationRequest(trajectory_id, step_index, fields);
  }
}
