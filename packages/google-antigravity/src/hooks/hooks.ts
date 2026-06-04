import {
  AskQuestionInteractionSpec,
  Content,
  HookResult,
  QuestionHookResult,
  ToolCall,
  ToolResult,
} from "../types.js";

export { AskQuestionInteractionSpec, HookResult, QuestionHookResult };

export class HookContext {
  readonly parent?: HookContext;
  #store = new Map<string, unknown>();

  constructor(parent?: HookContext) {
    this.parent = parent;
  }

  get<T = unknown>(key: string, defaultValue?: T): T | undefined {
    if (this.#store.has(key)) {
      return this.#store.get(key) as T;
    }
    return this.parent?.get(key, defaultValue) ?? defaultValue;
  }

  set(key: string, value: unknown): void {
    this.#store.set(key, value);
  }
}

export class SessionContext extends HookContext {
  constructor() {
    super();
  }
}

export class TurnContext extends HookContext {
  constructor(sessionContext: SessionContext) {
    super(sessionContext);
  }
}

export class OperationContext extends HookContext {
  constructor(turnContext: TurnContext) {
    super(turnContext);
  }
}

export class InspectHook<T> {
  async run(_context: HookContext, _data: T): Promise<void> {}
}

export class DecideHook<T> {
  async run(_context: HookContext, _data: T): Promise<HookResult> {
    return new HookResult({ allow: true });
  }
}

export class TransformHook<T, R> {
  async run(_context: HookContext, _data: T): Promise<R | undefined> {
    return undefined;
  }
}

export type Hook = InspectHook<unknown> | DecideHook<unknown> | TransformHook<unknown, unknown>;

export class OnSessionStartHook extends InspectHook<undefined> {}
export class OnSessionEndHook extends InspectHook<undefined> {}
export class PreTurnHook extends DecideHook<Content | undefined> {}
export class PostTurnHook extends InspectHook<string> {}
export class PreToolCallDecideHook extends DecideHook<ToolCall> {}
export class PostToolCallHook extends InspectHook<ToolResult> {}
export class OnToolErrorHook extends TransformHook<Error, unknown> {}
export class OnInteractionHook extends TransformHook<
  AskQuestionInteractionSpec,
  QuestionHookResult
> {}
export class OnCompactionHook extends InspectHook<unknown> {}

function makeHookDecorator<T extends Hook>(HookClass: new () => object, passData = true) {
  return function decorate(fn: (...args: any[]) => Promise<unknown>): T {
    const prototype = Object.create(HookClass.prototype) as {
      run(_context: HookContext, data: unknown): Promise<unknown>;
      call(...args: unknown[]): Promise<unknown>;
    };
    prototype.run = async (_context: HookContext, data: unknown) =>
      passData ? await fn(data) : await fn();
    prototype.call = async (...args: unknown[]) => await fn(...args);

    const callable = (async (...args: unknown[]) => await fn(...args)) as unknown as T;
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

export const pre_turn: typeof preTurn = preTurn;
export const pre_tool_call_decide: typeof preToolCallDecide = preToolCallDecide;
export const on_interaction: typeof onInteraction = onInteraction;
export const on_compaction: typeof onCompaction = onCompaction;
export const on_session_start: typeof onSessionStart = onSessionStart;
export const on_session_end: typeof onSessionEnd = onSessionEnd;
export const post_turn: typeof postTurn = postTurn;
export const post_tool_call: typeof postToolCall = postToolCall;
export const on_tool_error: typeof onToolError = onToolError;
