import {
  ChatResponse,
  ResponseChunk,
  Step,
  StepSource,
  StepTarget,
  StepType,
  Text,
  Thought,
  ToolCall,
  UsageMetadata,
} from "../types.js";
import { Connection, ConnectionStrategy } from "../connections/connection.js";

const DEFAULT_MAX_HISTORY_SIZE = 10_000;

function zeroUsage(): UsageMetadata {
  return new UsageMetadata({
    promptTokenCount: 0,
    cachedContentTokenCount: 0,
    candidatesTokenCount: 0,
    thoughtsTokenCount: 0,
    totalTokenCount: 0,
  });
}

function addUsage(target: UsageMetadata, source: UsageMetadata): void {
  target.promptTokenCount = (target.promptTokenCount ?? 0) + (source.promptTokenCount ?? 0);
  target.cachedContentTokenCount =
    (target.cachedContentTokenCount ?? 0) + (source.cachedContentTokenCount ?? 0);
  target.candidatesTokenCount =
    (target.candidatesTokenCount ?? 0) + (source.candidatesTokenCount ?? 0);
  target.thoughtsTokenCount = (target.thoughtsTokenCount ?? 0) + (source.thoughtsTokenCount ?? 0);
  target.totalTokenCount = (target.totalTokenCount ?? 0) + (source.totalTokenCount ?? 0);
}

function isConcurrentReceiveError(error: unknown): boolean {
  return (
    error instanceof Error &&
    (error.name === "RuntimeError" ||
      /concurrent\s+receivesteps|already\s+(?:running|receiving)/i.test(error.message))
  );
}

function exceptionType(error: unknown): unknown {
  return error instanceof Error ? error.constructor : undefined;
}

export class Conversation {
  #connection: Connection;
  #steps: Step[] = [];
  #turnStartIndices: number[] = [];
  #compactionIndices: number[] = [];
  #maxHistorySize: number;
  #cumulativeUsage = zeroUsage();
  #turnUsage?: UsageMetadata;

  constructor(
    connection: Connection,
    init: { maxHistorySize?: number; max_history_size?: number } = {},
  ) {
    this.#connection = connection;
    this.#maxHistorySize = init.maxHistorySize ?? init.max_history_size ?? DEFAULT_MAX_HISTORY_SIZE;
  }

  static async create(strategy: ConnectionStrategy): Promise<Conversation> {
    await strategy.start();
    try {
      return new Conversation(strategy.connect());
    } catch (error) {
      await strategy.stop(exceptionType(error), error);
      throw error;
    }
  }

  static async using<T>(
    strategy: ConnectionStrategy,
    callback: (conversation: Conversation) => T | Promise<T>,
  ): Promise<T> {
    await strategy.start();
    let callbackCompleted = false;
    try {
      const result = await callback(new Conversation(strategy.connect()));
      callbackCompleted = true;
      return result;
    } catch (error) {
      await strategy.stop(exceptionType(error), error);
      throw error;
    } finally {
      if (callbackCompleted) {
        await strategy.stop();
      }
    }
  }

  async send(
    prompt: import("../types.js").Content | undefined,
    options?: Record<string, unknown>,
  ): Promise<void> {
    if (!this.#connection.isIdle) {
      try {
        for await (const _ of this.receiveSteps()) {
          void _;
        }
      } catch (error) {
        if (!isConcurrentReceiveError(error)) {
          throw error;
        }
        await this.#connection.waitForIdle();
      }
    }
    this.#turnStartIndices.push(this.#steps.length);
    this.#turnUsage = undefined;
    await this.#connection.send(prompt, options);
  }

  async *receiveSteps(): AsyncIterable<Step> {
    for await (const rawStep of this.#connection.receiveSteps()) {
      const step = rawStep instanceof Step ? rawStep : new Step(rawStep);
      this.#steps.push(step);
      if (step.type === StepType.COMPACTION) {
        this.#compactionIndices.push(this.#steps.length - 1);
      }
      if (step.usageMetadata) {
        this.#accumulateUsage(step.usageMetadata);
      }
      this.#enforceMaxHistory();
      yield step;
    }
  }

  receive_steps(): AsyncIterable<Step> {
    return this.receiveSteps();
  }

  async *receiveChunks(): AsyncIterable<ResponseChunk> {
    const seenToolIds = new Set<string>();
    for await (const step of this.receiveSteps()) {
      const isModel = step.source === StepSource.MODEL;
      const isTargetUser = step.target === StepTarget.USER;

      if (isModel && isTargetUser) {
        if (step.thinkingDelta) {
          yield new Thought({
            stepIndex: step.stepIndex,
            text: step.thinkingDelta,
          });
        }
        if (step.contentDelta) {
          yield new Text({
            stepIndex: step.stepIndex,
            text: step.contentDelta,
          });
        }
      }

      for (const call of step.toolCalls) {
        if (call.id === undefined || !seenToolIds.has(call.id)) {
          if (call.id !== undefined) {
            seenToolIds.add(call.id);
          }
          yield call instanceof ToolCall ? call : new ToolCall(call);
        }
      }
    }
  }

  receive_chunks(): AsyncIterable<ResponseChunk> {
    return this.receiveChunks();
  }

  getLastStructuredOutput(): unknown | undefined {
    for (let i = this.#steps.length - 1; i >= 0; i -= 1) {
      const step = this.#steps[i]!;
      if (step.type === StepType.FINISH) {
        return step.structuredOutput;
      }
    }
    return undefined;
  }

  get_last_structured_output(): unknown | undefined {
    return this.getLastStructuredOutput();
  }

  async chat(
    prompt?: import("../types.js").Content,
    options?: Record<string, unknown>,
  ): Promise<ChatResponse> {
    await this.send(prompt, options);
    return new ChatResponse(this.receiveChunks(), this);
  }

  get history(): Step[] {
    return [...this.#steps];
  }

  get lastResponse(): string {
    for (let i = this.#steps.length - 1; i >= 0; i -= 1) {
      const step = this.#steps[i]!;
      if (step.isCompleteResponse) {
        return step.content;
      }
    }
    return "";
  }

  get last_response(): string {
    return this.lastResponse;
  }

  get turnCount(): number {
    return this.#turnStartIndices.length;
  }

  get turn_count(): number {
    return this.turnCount;
  }

  get compactionIndices(): number[] {
    return [...this.#compactionIndices];
  }

  get compaction_indices(): number[] {
    return this.compactionIndices;
  }

  clearHistory(): void {
    this.#steps = [];
    this.#turnStartIndices = [];
    this.#compactionIndices = [];
    this.#cumulativeUsage = zeroUsage();
    this.#turnUsage = undefined;
  }

  clear_history(): void {
    this.clearHistory();
  }

  #enforceMaxHistory(): void {
    if (this.#maxHistorySize && this.#steps.length > this.#maxHistorySize) {
      const overflow = this.#steps.length - this.#maxHistorySize;
      this.#steps = this.#steps.slice(overflow);
      this.#turnStartIndices = this.#turnStartIndices
        .filter((index) => index >= overflow)
        .map((index) => index - overflow);
      this.#compactionIndices = this.#compactionIndices
        .filter((index) => index >= overflow)
        .map((index) => index - overflow);
    }
  }

  get connection(): Connection {
    return this.#connection;
  }

  get isIdle(): boolean {
    return this.#connection.isIdle;
  }

  get is_idle(): boolean {
    return this.isIdle;
  }

  get conversationId(): string {
    return this.#connection.conversationId;
  }

  get conversation_id(): string {
    return this.conversationId;
  }

  get totalUsage(): UsageMetadata {
    return new UsageMetadata(this.#cumulativeUsage);
  }

  get total_usage(): UsageMetadata {
    return this.totalUsage;
  }

  get lastTurnUsage(): UsageMetadata | undefined {
    return this.#turnUsage ? new UsageMetadata(this.#turnUsage) : undefined;
  }

  get last_turn_usage(): UsageMetadata | undefined {
    return this.lastTurnUsage;
  }

  #accumulateUsage(usage: UsageMetadata): void {
    addUsage(this.#cumulativeUsage, usage);
    this.#turnUsage ??= zeroUsage();
    addUsage(this.#turnUsage, usage);
  }

  cancel(): Promise<void> {
    return this.#connection.cancel();
  }

  delete(): Promise<void> {
    return this.#connection.delete();
  }

  signalIdle(): Promise<void> {
    return this.#connection.signalIdle();
  }

  signal_idle(): Promise<void> {
    return this.signalIdle();
  }

  waitForIdle(): Promise<void> {
    return this.#connection.waitForIdle();
  }

  wait_for_idle(): Promise<void> {
    return this.waitForIdle();
  }

  waitForWakeup(timeout = 300): Promise<boolean> {
    return this.#connection.waitForWakeup(timeout);
  }

  wait_for_wakeup(timeout = 300): Promise<boolean> {
    return this.waitForWakeup(timeout);
  }

  disconnect(): Promise<void> {
    return this.#connection.disconnect();
  }
}
