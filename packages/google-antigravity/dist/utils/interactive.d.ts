import { AskQuestionInteractionSpec, HookResult, QuestionHookResult, ToolCall } from "../types.js";
import { HookContext, OnInteractionHook, PreToolCallDecideHook } from "../hooks/hooks.js";
import type { Agent } from "../agent.js";
export type InteractiveIO = {
    input?: NodeJS.ReadableStream;
    output?: NodeJS.WritableStream;
    read?: (prompt: string) => Promise<string>;
};
export declare function asyncInput(prompt?: string, io?: InteractiveIO): Promise<string>;
export declare const async_input: typeof asyncInput;
export declare class Spinner implements AsyncDisposable {
    #private;
    constructor(message?: string, enabled?: boolean);
    update(message: string): void;
    start(): this;
    stop(): void;
    [Symbol.asyncDispose](): Promise<void>;
}
export declare class ToolConfirmationHook extends PreToolCallDecideHook {
    #private;
    constructor(io?: InteractiveIO);
    run(_context: HookContext, data: ToolCall): Promise<HookResult>;
}
export declare function askUserHandler(toolCall: ToolCall, io?: InteractiveIO): Promise<boolean>;
export declare const ask_user_handler: typeof askUserHandler;
export declare function _upgrade_to_interactive_confirmation(agent: Agent, io?: InteractiveIO): void;
export declare class AskQuestionHook extends OnInteractionHook {
    #private;
    constructor(io?: InteractiveIO);
    run(_context: HookContext, data: AskQuestionInteractionSpec): Promise<QuestionHookResult>;
}
export declare function runInteractiveLoop(agent: Agent, io?: InteractiveIO): Promise<void>;
export declare const run_interactive_loop: typeof runInteractiveLoop;
//# sourceMappingURL=interactive.d.ts.map