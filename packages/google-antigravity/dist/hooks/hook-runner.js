import { AntigravityValidationError, HookResult } from "../types.js";
import { OnCompactionHook, OnInteractionHook, OnSessionEndHook, OnSessionStartHook, OnToolErrorHook, OperationContext, PostToolCallHook, PostTurnHook, PreToolCallDecideHook, PreTurnHook, SessionContext, TurnContext, } from "./hooks.js";
export class HookRunner {
    #onSessionStartHooks;
    #onSessionEndHooks;
    #preTurnHooks;
    #postTurnHooks;
    #preToolCallDecideHooks;
    #postToolCallHooks;
    #onToolErrorHooks;
    #onInteractionHooks;
    #onCompactionHooks;
    sessionContext = new SessionContext();
    constructor(init = {}) {
        this.#onSessionStartHooks = [
            ...(init.onSessionStartHooks ?? init.on_session_start_hooks ?? []),
        ];
        this.#onSessionEndHooks = [...(init.onSessionEndHooks ?? init.on_session_end_hooks ?? [])];
        this.#preTurnHooks = [...(init.preTurnHooks ?? init.pre_turn_hooks ?? [])];
        this.#postTurnHooks = [...(init.postTurnHooks ?? init.post_turn_hooks ?? [])];
        this.#preToolCallDecideHooks = [
            ...(init.preToolCallDecideHooks ?? init.pre_tool_call_decide_hooks ?? []),
        ];
        this.#postToolCallHooks = [...(init.postToolCallHooks ?? init.post_tool_call_hooks ?? [])];
        this.#onToolErrorHooks = [...(init.onToolErrorHooks ?? init.on_tool_error_hooks ?? [])];
        this.#onInteractionHooks = [...(init.onInteractionHooks ?? init.on_interaction_hooks ?? [])];
        this.#onCompactionHooks = [...(init.onCompactionHooks ?? init.on_compaction_hooks ?? [])];
    }
    get session_context() {
        return this.sessionContext;
    }
    set session_context(value) {
        this.sessionContext = value;
    }
    get hasHooks() {
        return Boolean(this.#onSessionStartHooks.length ||
            this.#onSessionEndHooks.length ||
            this.#preTurnHooks.length ||
            this.#postTurnHooks.length ||
            this.#preToolCallDecideHooks.length ||
            this.#postToolCallHooks.length ||
            this.#onToolErrorHooks.length ||
            this.#onInteractionHooks.length ||
            this.#onCompactionHooks.length);
    }
    get has_hooks() {
        return this.hasHooks;
    }
    get preToolCallDecideHooks() {
        return [...this.#preToolCallDecideHooks];
    }
    get pre_tool_call_decide_hooks() {
        return this.preToolCallDecideHooks;
    }
    get onSessionStartHooks() {
        return [...this.#onSessionStartHooks];
    }
    get on_session_start_hooks() {
        return this.onSessionStartHooks;
    }
    get onSessionEndHooks() {
        return [...this.#onSessionEndHooks];
    }
    get on_session_end_hooks() {
        return this.onSessionEndHooks;
    }
    get preTurnHooks() {
        return [...this.#preTurnHooks];
    }
    get pre_turn_hooks() {
        return this.preTurnHooks;
    }
    get postTurnHooks() {
        return [...this.#postTurnHooks];
    }
    get post_turn_hooks() {
        return this.postTurnHooks;
    }
    get postToolCallHooks() {
        return [...this.#postToolCallHooks];
    }
    get post_tool_call_hooks() {
        return this.postToolCallHooks;
    }
    get onToolErrorHooks() {
        return [...this.#onToolErrorHooks];
    }
    get on_tool_error_hooks() {
        return this.onToolErrorHooks;
    }
    get onInteractionHooks() {
        return [...this.#onInteractionHooks];
    }
    get on_interaction_hooks() {
        return this.onInteractionHooks;
    }
    get onCompactionHooks() {
        return [...this.#onCompactionHooks];
    }
    get on_compaction_hooks() {
        return this.onCompactionHooks;
    }
    registerHook(hook) {
        if (hook instanceof OnSessionStartHook) {
            this.#onSessionStartHooks.push(hook);
        }
        else if (hook instanceof OnSessionEndHook) {
            this.#onSessionEndHooks.push(hook);
        }
        else if (hook instanceof PreTurnHook) {
            this.#preTurnHooks.push(hook);
        }
        else if (hook instanceof PostTurnHook) {
            this.#postTurnHooks.push(hook);
        }
        else if (hook instanceof PreToolCallDecideHook) {
            this.#preToolCallDecideHooks.push(hook);
        }
        else if (hook instanceof PostToolCallHook) {
            this.#postToolCallHooks.push(hook);
        }
        else if (hook instanceof OnToolErrorHook) {
            this.#onToolErrorHooks.push(hook);
        }
        else if (hook instanceof OnInteractionHook) {
            this.#onInteractionHooks.push(hook);
        }
        else if (hook instanceof OnCompactionHook) {
            this.#onCompactionHooks.push(hook);
        }
        else {
            const hookType = hook && typeof hook === "object" ? hook.constructor.name : typeof hook;
            throw new AntigravityValidationError(`Unknown hook type: ${hookType}`);
        }
    }
    register_hook(hook) {
        this.registerHook(hook);
    }
    replacePreToolCallDecideHook(predicate, replacement) {
        const index = this.#preToolCallDecideHooks.findIndex(predicate);
        if (index === -1) {
            return false;
        }
        this.#preToolCallDecideHooks[index] = replacement;
        return true;
    }
    async dispatchSessionStart() {
        for (const hook of this.#onSessionStartHooks) {
            await hook.run(this.sessionContext, undefined);
        }
    }
    dispatch_session_start() {
        return this.dispatchSessionStart();
    }
    async dispatchSessionEnd() {
        for (const hook of this.#onSessionEndHooks) {
            await hook.run(this.sessionContext, undefined);
        }
    }
    dispatch_session_end() {
        return this.dispatchSessionEnd();
    }
    async dispatchPreTurn(prompt) {
        const turnContext = new TurnContext(this.sessionContext);
        for (const hook of this.#preTurnHooks) {
            const result = await hook.run(turnContext, prompt ?? "");
            if (!result.allow) {
                return [result, turnContext];
            }
        }
        return [new HookResult({ allow: true }), turnContext];
    }
    dispatch_pre_turn(prompt) {
        return this.dispatchPreTurn(prompt);
    }
    async dispatchPostTurn(turnContext, response) {
        for (const hook of this.#postTurnHooks) {
            await hook.run(turnContext, response);
        }
    }
    dispatch_post_turn(turnContext, response) {
        return this.dispatchPostTurn(turnContext, response);
    }
    async dispatchPreToolCall(turnContext, toolCall) {
        const opContext = new OperationContext(turnContext);
        for (const hook of this.#preToolCallDecideHooks) {
            const result = await hook.run(opContext, toolCall);
            if (!result.allow) {
                return [result, toolCall, opContext];
            }
        }
        return [new HookResult({ allow: true }), toolCall, opContext];
    }
    dispatch_pre_tool_call(turnContext, toolCall) {
        return this.dispatchPreToolCall(turnContext, toolCall);
    }
    async dispatchPostToolCall(opContext, result) {
        for (const hook of this.#postToolCallHooks) {
            await hook.run(opContext, result);
        }
    }
    dispatch_post_tool_call(opContext, result) {
        return this.dispatchPostToolCall(opContext, result);
    }
    async dispatchOnToolError(opContext, error) {
        for (const hook of this.#onToolErrorHooks) {
            try {
                const result = await hook.run(opContext, error);
                if (result !== undefined && result !== null) {
                    return [new HookResult({ allow: true }), result];
                }
            }
            catch (recoveryError) {
                return [
                    new HookResult({
                        allow: false,
                        message: `Error recovery failed: ${String(recoveryError)}`,
                    }),
                    undefined,
                ];
            }
        }
        return [new HookResult({ allow: false }), undefined];
    }
    dispatch_on_tool_error(opContext, error) {
        return this.dispatchOnToolError(opContext, error);
    }
    async dispatchInteraction(turnContext, interactionSpec) {
        const opContext = new OperationContext(turnContext);
        for (const hook of this.#onInteractionHooks) {
            const result = await hook.run(opContext, interactionSpec);
            if (result !== undefined && result !== null) {
                return [new HookResult({ allow: true }), result, opContext];
            }
        }
        return [
            new HookResult({
                allow: false,
                message: "No interaction hook handled the request",
            }),
            undefined,
            opContext,
        ];
    }
    dispatch_interaction(turnContext, interactionSpec) {
        return this.dispatchInteraction(turnContext, interactionSpec);
    }
    async dispatchCompaction(turnContext, data) {
        const opContext = new OperationContext(turnContext);
        for (const hook of this.#onCompactionHooks) {
            await hook.run(opContext, data);
        }
    }
    dispatch_compaction(turnContext, data) {
        return this.dispatchCompaction(turnContext, data);
    }
}
//# sourceMappingURL=hook-runner.js.map