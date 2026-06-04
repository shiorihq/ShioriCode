import { AskQuestionInteractionSpec, Content, HookResult, QuestionHookResult, ToolCall, ToolResult } from "../types.js";
export { AskQuestionInteractionSpec, HookResult, QuestionHookResult };
export declare class HookContext {
    #private;
    readonly parent?: HookContext;
    constructor(parent?: HookContext);
    get<T = unknown>(key: string, defaultValue?: T): T | undefined;
    set(key: string, value: unknown): void;
}
export declare class SessionContext extends HookContext {
    constructor();
}
export declare class TurnContext extends HookContext {
    constructor(sessionContext: SessionContext);
}
export declare class OperationContext extends HookContext {
    constructor(turnContext: TurnContext);
}
export declare class InspectHook<T> {
    run(_context: HookContext, _data: T): Promise<void>;
}
export declare class DecideHook<T> {
    run(_context: HookContext, _data: T): Promise<HookResult>;
}
export declare class TransformHook<T, R> {
    run(_context: HookContext, _data: T): Promise<R | undefined>;
}
export type Hook = InspectHook<unknown> | DecideHook<unknown> | TransformHook<unknown, unknown>;
export declare class OnSessionStartHook extends InspectHook<undefined> {
}
export declare class OnSessionEndHook extends InspectHook<undefined> {
}
export declare class PreTurnHook extends DecideHook<Content | undefined> {
}
export declare class PostTurnHook extends InspectHook<string> {
}
export declare class PreToolCallDecideHook extends DecideHook<ToolCall> {
}
export declare class PostToolCallHook extends InspectHook<ToolResult> {
}
export declare class OnToolErrorHook extends TransformHook<Error, unknown> {
}
export declare class OnInteractionHook extends TransformHook<AskQuestionInteractionSpec, QuestionHookResult> {
}
export declare class OnCompactionHook extends InspectHook<unknown> {
}
export declare const preTurn: (fn: (...args: any[]) => Promise<unknown>) => Hook;
export declare const preToolCallDecide: (fn: (...args: any[]) => Promise<unknown>) => Hook;
export declare const onInteraction: (fn: (...args: any[]) => Promise<unknown>) => Hook;
export declare const onCompaction: (fn: (...args: any[]) => Promise<unknown>) => Hook;
export declare const onSessionStart: (fn: (...args: any[]) => Promise<unknown>) => Hook;
export declare const onSessionEnd: (fn: (...args: any[]) => Promise<unknown>) => Hook;
export declare const postTurn: (fn: (...args: any[]) => Promise<unknown>) => Hook;
export declare const postToolCall: (fn: (...args: any[]) => Promise<unknown>) => Hook;
export declare const onToolError: (fn: (...args: any[]) => Promise<unknown>) => Hook;
export declare const pre_turn: typeof preTurn;
export declare const pre_tool_call_decide: typeof preToolCallDecide;
export declare const on_interaction: typeof onInteraction;
export declare const on_compaction: typeof onCompaction;
export declare const on_session_start: typeof onSessionStart;
export declare const on_session_end: typeof onSessionEnd;
export declare const post_turn: typeof postTurn;
export declare const post_tool_call: typeof postToolCall;
export declare const on_tool_error: typeof onToolError;
//# sourceMappingURL=hooks.d.ts.map