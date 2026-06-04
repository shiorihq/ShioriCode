import { ChatResponse, Step, StepSource, StepTarget, StepType, Text, Thought, ToolCall, UsageMetadata, } from "../types.js";
const DEFAULT_MAX_HISTORY_SIZE = 10_000;
function zeroUsage() {
    return new UsageMetadata({
        promptTokenCount: 0,
        cachedContentTokenCount: 0,
        candidatesTokenCount: 0,
        thoughtsTokenCount: 0,
        totalTokenCount: 0,
    });
}
function addUsage(target, source) {
    target.promptTokenCount = (target.promptTokenCount ?? 0) + (source.promptTokenCount ?? 0);
    target.cachedContentTokenCount =
        (target.cachedContentTokenCount ?? 0) + (source.cachedContentTokenCount ?? 0);
    target.candidatesTokenCount =
        (target.candidatesTokenCount ?? 0) + (source.candidatesTokenCount ?? 0);
    target.thoughtsTokenCount = (target.thoughtsTokenCount ?? 0) + (source.thoughtsTokenCount ?? 0);
    target.totalTokenCount = (target.totalTokenCount ?? 0) + (source.totalTokenCount ?? 0);
}
function isConcurrentReceiveError(error) {
    return (error instanceof Error &&
        (error.name === "RuntimeError" ||
            /concurrent\s+receivesteps|already\s+(?:running|receiving)/i.test(error.message)));
}
function exceptionType(error) {
    return error instanceof Error ? error.constructor : undefined;
}
export class Conversation {
    #connection;
    #steps = [];
    #turnStartIndices = [];
    #compactionIndices = [];
    #maxHistorySize;
    #cumulativeUsage = zeroUsage();
    #turnUsage;
    constructor(connection, init = {}) {
        this.#connection = connection;
        this.#maxHistorySize = init.maxHistorySize ?? init.max_history_size ?? DEFAULT_MAX_HISTORY_SIZE;
    }
    static async create(strategy) {
        await strategy.start();
        try {
            return new Conversation(strategy.connect());
        }
        catch (error) {
            await strategy.stop(exceptionType(error), error);
            throw error;
        }
    }
    static async using(strategy, callback) {
        await strategy.start();
        let callbackCompleted = false;
        try {
            const result = await callback(new Conversation(strategy.connect()));
            callbackCompleted = true;
            return result;
        }
        catch (error) {
            await strategy.stop(exceptionType(error), error);
            throw error;
        }
        finally {
            if (callbackCompleted) {
                await strategy.stop();
            }
        }
    }
    async send(prompt, options) {
        if (!this.#connection.isIdle) {
            try {
                for await (const _ of this.receiveSteps()) {
                    void _;
                }
            }
            catch (error) {
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
    async *receiveSteps() {
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
    receive_steps() {
        return this.receiveSteps();
    }
    async *receiveChunks() {
        const seenToolIds = new Set();
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
    receive_chunks() {
        return this.receiveChunks();
    }
    getLastStructuredOutput() {
        for (let i = this.#steps.length - 1; i >= 0; i -= 1) {
            const step = this.#steps[i];
            if (step.type === StepType.FINISH) {
                return step.structuredOutput;
            }
        }
        return undefined;
    }
    get_last_structured_output() {
        return this.getLastStructuredOutput();
    }
    async chat(prompt, options) {
        await this.send(prompt, options);
        return new ChatResponse(this.receiveChunks(), this);
    }
    get history() {
        return [...this.#steps];
    }
    get lastResponse() {
        for (let i = this.#steps.length - 1; i >= 0; i -= 1) {
            const step = this.#steps[i];
            if (step.isCompleteResponse) {
                return step.content;
            }
        }
        return "";
    }
    get last_response() {
        return this.lastResponse;
    }
    get turnCount() {
        return this.#turnStartIndices.length;
    }
    get turn_count() {
        return this.turnCount;
    }
    get compactionIndices() {
        return [...this.#compactionIndices];
    }
    get compaction_indices() {
        return this.compactionIndices;
    }
    clearHistory() {
        this.#steps = [];
        this.#turnStartIndices = [];
        this.#compactionIndices = [];
        this.#cumulativeUsage = zeroUsage();
        this.#turnUsage = undefined;
    }
    clear_history() {
        this.clearHistory();
    }
    #enforceMaxHistory() {
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
    get connection() {
        return this.#connection;
    }
    get isIdle() {
        return this.#connection.isIdle;
    }
    get is_idle() {
        return this.isIdle;
    }
    get conversationId() {
        return this.#connection.conversationId;
    }
    get conversation_id() {
        return this.conversationId;
    }
    get totalUsage() {
        return new UsageMetadata(this.#cumulativeUsage);
    }
    get total_usage() {
        return this.totalUsage;
    }
    get lastTurnUsage() {
        return this.#turnUsage ? new UsageMetadata(this.#turnUsage) : undefined;
    }
    get last_turn_usage() {
        return this.lastTurnUsage;
    }
    #accumulateUsage(usage) {
        addUsage(this.#cumulativeUsage, usage);
        this.#turnUsage ??= zeroUsage();
        addUsage(this.#turnUsage, usage);
    }
    cancel() {
        return this.#connection.cancel();
    }
    delete() {
        return this.#connection.delete();
    }
    signalIdle() {
        return this.#connection.signalIdle();
    }
    signal_idle() {
        return this.signalIdle();
    }
    waitForIdle() {
        return this.#connection.waitForIdle();
    }
    wait_for_idle() {
        return this.waitForIdle();
    }
    waitForWakeup(timeout = 300) {
        return this.#connection.waitForWakeup(timeout);
    }
    wait_for_wakeup(timeout = 300) {
        return this.waitForWakeup(timeout);
    }
    disconnect() {
        return this.#connection.disconnect();
    }
}
//# sourceMappingURL=conversation.js.map