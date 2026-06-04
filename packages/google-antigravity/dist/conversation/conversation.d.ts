import { ChatResponse, ResponseChunk, Step, UsageMetadata } from "../types.js";
import { Connection, ConnectionStrategy } from "../connections/connection.js";
export declare class Conversation {
    #private;
    constructor(connection: Connection, init?: {
        maxHistorySize?: number;
        max_history_size?: number;
    });
    static create(strategy: ConnectionStrategy): Promise<Conversation>;
    static using<T>(strategy: ConnectionStrategy, callback: (conversation: Conversation) => T | Promise<T>): Promise<T>;
    send(prompt: import("../types.js").Content | undefined, options?: Record<string, unknown>): Promise<void>;
    receiveSteps(): AsyncIterable<Step>;
    receive_steps(): AsyncIterable<Step>;
    receiveChunks(): AsyncIterable<ResponseChunk>;
    receive_chunks(): AsyncIterable<ResponseChunk>;
    getLastStructuredOutput(): unknown | undefined;
    get_last_structured_output(): unknown | undefined;
    chat(prompt?: import("../types.js").Content, options?: Record<string, unknown>): Promise<ChatResponse>;
    get history(): Step[];
    get lastResponse(): string;
    get last_response(): string;
    get turnCount(): number;
    get turn_count(): number;
    get compactionIndices(): number[];
    get compaction_indices(): number[];
    clearHistory(): void;
    clear_history(): void;
    get connection(): Connection;
    get isIdle(): boolean;
    get is_idle(): boolean;
    get conversationId(): string;
    get conversation_id(): string;
    get totalUsage(): UsageMetadata;
    get total_usage(): UsageMetadata;
    get lastTurnUsage(): UsageMetadata | undefined;
    get last_turn_usage(): UsageMetadata | undefined;
    cancel(): Promise<void>;
    delete(): Promise<void>;
    signalIdle(): Promise<void>;
    signal_idle(): Promise<void>;
    waitForIdle(): Promise<void>;
    wait_for_idle(): Promise<void>;
    waitForWakeup(timeout?: number): Promise<boolean>;
    wait_for_wakeup(timeout?: number): Promise<boolean>;
    disconnect(): Promise<void>;
}
//# sourceMappingURL=conversation.d.ts.map