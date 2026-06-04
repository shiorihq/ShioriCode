import { HookRunner } from "../../hooks/hook-runner.js";
import { ToolRunner } from "../../tools/tool-runner.js";
import { LocalConnection } from "./local-connection.js";
declare class AsyncQueue<T> {
    #private;
    push(item: T): void;
    shift(timeoutMs?: number): Promise<T>;
}
export declare class TestWebSocket extends EventTarget {
    #private;
    sentMessages: string[];
    sentQueue: AsyncQueue<string>;
    readyState: number;
    send(message: string): void;
    putEvent(event: Record<string, unknown>): void;
    close(): void;
    nextSent(timeoutMs?: number): Promise<string>;
    [Symbol.asyncIterator](): AsyncIterator<string>;
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
export declare class TestLocalHarness {
    ws: TestWebSocket;
    conn: LocalConnection;
    constructor(init?: TestLocalHarnessInit);
    disconnectSdk(): Promise<void>;
    disconnect_sdk(): Promise<void>;
    closeFromHarnessSide(): Promise<void>;
    close_from_harness_side(): Promise<void>;
    waitForResponse(timeout?: number): Promise<Record<string, unknown>>;
    wait_for_response(timeout?: number): Promise<Record<string, unknown>>;
    waitForEvent(event: Promise<unknown>, timeout?: number): Promise<void>;
    wait_for_event(event: Promise<unknown>, timeout?: number): Promise<void>;
    sendEvent(event: Record<string, unknown>): Promise<void>;
    send_event(event: Record<string, unknown>): Promise<void>;
    sendToolCall(id: string, name: string, argumentsJson: string): Promise<void>;
    send_tool_call(id: string, name: string, arguments_json: string): Promise<void>;
    sendToolConfirmationRequest(trajectoryId: string, stepIndex: number, fields?: Record<string, unknown>): Promise<void>;
    send_tool_confirmation_request(trajectory_id: string, step_index: number, fields?: Record<string, unknown>): Promise<void>;
}
export {};
//# sourceMappingURL=test-utils.d.ts.map