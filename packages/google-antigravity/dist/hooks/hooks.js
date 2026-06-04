import { AskQuestionInteractionSpec, HookResult, QuestionHookResult, } from "../types.js";
export { AskQuestionInteractionSpec, HookResult, QuestionHookResult };
export class HookContext {
    parent;
    #store = new Map();
    constructor(parent) {
        this.parent = parent;
    }
    get(key, defaultValue) {
        if (this.#store.has(key)) {
            return this.#store.get(key);
        }
        return this.parent?.get(key, defaultValue) ?? defaultValue;
    }
    set(key, value) {
        this.#store.set(key, value);
    }
}
export class SessionContext extends HookContext {
    constructor() {
        super();
    }
}
export class TurnContext extends HookContext {
    constructor(sessionContext) {
        super(sessionContext);
    }
}
export class OperationContext extends HookContext {
    constructor(turnContext) {
        super(turnContext);
    }
}
export class InspectHook {
    async run(_context, _data) { }
}
export class DecideHook {
    async run(_context, _data) {
        return new HookResult({ allow: true });
    }
}
export class TransformHook {
    async run(_context, _data) {
        return undefined;
    }
}
export class OnSessionStartHook extends InspectHook {
}
export class OnSessionEndHook extends InspectHook {
}
export class PreTurnHook extends DecideHook {
}
export class PostTurnHook extends InspectHook {
}
export class PreToolCallDecideHook extends DecideHook {
}
export class PostToolCallHook extends InspectHook {
}
export class OnToolErrorHook extends TransformHook {
}
export class OnInteractionHook extends TransformHook {
}
export class OnCompactionHook extends InspectHook {
}
function makeHookDecorator(HookClass, passData = true) {
    return function decorate(fn) {
        const prototype = Object.create(HookClass.prototype);
        prototype.run = async (_context, data) => passData ? await fn(data) : await fn();
        prototype.call = async (...args) => await fn(...args);
        const callable = (async (...args) => await fn(...args));
        Object.setPrototypeOf(callable, prototype);
        return callable;
    };
}
export const preTurn = makeHookDecorator(PreTurnHook);
export const preToolCallDecide = makeHookDecorator(PreToolCallDecideHook);
export const onInteraction = makeHookDecorator(OnInteractionHook);
export const onCompaction = makeHookDecorator(OnCompactionHook);
export const onSessionStart = makeHookDecorator(OnSessionStartHook, false);
export const onSessionEnd = makeHookDecorator(OnSessionEndHook, false);
export const postTurn = makeHookDecorator(PostTurnHook);
export const postToolCall = makeHookDecorator(PostToolCallHook);
export const onToolError = makeHookDecorator(OnToolErrorHook);
export const pre_turn = preTurn;
export const pre_tool_call_decide = preToolCallDecide;
export const on_interaction = onInteraction;
export const on_compaction = onCompaction;
export const on_session_start = onSessionStart;
export const on_session_end = onSessionEnd;
export const post_turn = postTurn;
export const post_tool_call = postToolCall;
export const on_tool_error = onToolError;
//# sourceMappingURL=hooks.js.map