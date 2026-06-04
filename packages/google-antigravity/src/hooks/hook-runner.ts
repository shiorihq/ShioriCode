import { AntigravityValidationError, Content, HookResult, ToolCall, ToolResult } from "../types.js";
import {
  Hook,
  OnCompactionHook,
  OnInteractionHook,
  OnSessionEndHook,
  OnSessionStartHook,
  OnToolErrorHook,
  OperationContext,
  PostToolCallHook,
  PostTurnHook,
  PreToolCallDecideHook,
  PreTurnHook,
  SessionContext,
  TurnContext,
} from "./hooks.js";

type HookRunnerInit = {
  onSessionStartHooks?: OnSessionStartHook[];
  on_session_start_hooks?: OnSessionStartHook[];
  onSessionEndHooks?: OnSessionEndHook[];
  on_session_end_hooks?: OnSessionEndHook[];
  preTurnHooks?: PreTurnHook[];
  pre_turn_hooks?: PreTurnHook[];
  postTurnHooks?: PostTurnHook[];
  post_turn_hooks?: PostTurnHook[];
  preToolCallDecideHooks?: PreToolCallDecideHook[];
  pre_tool_call_decide_hooks?: PreToolCallDecideHook[];
  postToolCallHooks?: PostToolCallHook[];
  post_tool_call_hooks?: PostToolCallHook[];
  onToolErrorHooks?: OnToolErrorHook[];
  on_tool_error_hooks?: OnToolErrorHook[];
  onInteractionHooks?: OnInteractionHook[];
  on_interaction_hooks?: OnInteractionHook[];
  onCompactionHooks?: OnCompactionHook[];
  on_compaction_hooks?: OnCompactionHook[];
};

export class HookRunner {
  #onSessionStartHooks: OnSessionStartHook[];
  #onSessionEndHooks: OnSessionEndHook[];
  #preTurnHooks: PreTurnHook[];
  #postTurnHooks: PostTurnHook[];
  #preToolCallDecideHooks: PreToolCallDecideHook[];
  #postToolCallHooks: PostToolCallHook[];
  #onToolErrorHooks: OnToolErrorHook[];
  #onInteractionHooks: OnInteractionHook[];
  #onCompactionHooks: OnCompactionHook[];
  sessionContext = new SessionContext();

  constructor(init: HookRunnerInit = {}) {
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

  get session_context(): SessionContext {
    return this.sessionContext;
  }

  set session_context(value: SessionContext) {
    this.sessionContext = value;
  }

  get hasHooks(): boolean {
    return Boolean(
      this.#onSessionStartHooks.length ||
      this.#onSessionEndHooks.length ||
      this.#preTurnHooks.length ||
      this.#postTurnHooks.length ||
      this.#preToolCallDecideHooks.length ||
      this.#postToolCallHooks.length ||
      this.#onToolErrorHooks.length ||
      this.#onInteractionHooks.length ||
      this.#onCompactionHooks.length,
    );
  }

  get has_hooks(): boolean {
    return this.hasHooks;
  }

  get preToolCallDecideHooks(): readonly PreToolCallDecideHook[] {
    return [...this.#preToolCallDecideHooks];
  }

  get pre_tool_call_decide_hooks(): readonly PreToolCallDecideHook[] {
    return this.preToolCallDecideHooks;
  }

  get onSessionStartHooks(): readonly OnSessionStartHook[] {
    return [...this.#onSessionStartHooks];
  }

  get on_session_start_hooks(): readonly OnSessionStartHook[] {
    return this.onSessionStartHooks;
  }

  get onSessionEndHooks(): readonly OnSessionEndHook[] {
    return [...this.#onSessionEndHooks];
  }

  get on_session_end_hooks(): readonly OnSessionEndHook[] {
    return this.onSessionEndHooks;
  }

  get preTurnHooks(): readonly PreTurnHook[] {
    return [...this.#preTurnHooks];
  }

  get pre_turn_hooks(): readonly PreTurnHook[] {
    return this.preTurnHooks;
  }

  get postTurnHooks(): readonly PostTurnHook[] {
    return [...this.#postTurnHooks];
  }

  get post_turn_hooks(): readonly PostTurnHook[] {
    return this.postTurnHooks;
  }

  get postToolCallHooks(): readonly PostToolCallHook[] {
    return [...this.#postToolCallHooks];
  }

  get post_tool_call_hooks(): readonly PostToolCallHook[] {
    return this.postToolCallHooks;
  }

  get onToolErrorHooks(): readonly OnToolErrorHook[] {
    return [...this.#onToolErrorHooks];
  }

  get on_tool_error_hooks(): readonly OnToolErrorHook[] {
    return this.onToolErrorHooks;
  }

  get onInteractionHooks(): readonly OnInteractionHook[] {
    return [...this.#onInteractionHooks];
  }

  get on_interaction_hooks(): readonly OnInteractionHook[] {
    return this.onInteractionHooks;
  }

  get onCompactionHooks(): readonly OnCompactionHook[] {
    return [...this.#onCompactionHooks];
  }

  get on_compaction_hooks(): readonly OnCompactionHook[] {
    return this.onCompactionHooks;
  }

  registerHook(hook: Hook): void {
    if (hook instanceof OnSessionStartHook) {
      this.#onSessionStartHooks.push(hook);
    } else if (hook instanceof OnSessionEndHook) {
      this.#onSessionEndHooks.push(hook);
    } else if (hook instanceof PreTurnHook) {
      this.#preTurnHooks.push(hook);
    } else if (hook instanceof PostTurnHook) {
      this.#postTurnHooks.push(hook);
    } else if (hook instanceof PreToolCallDecideHook) {
      this.#preToolCallDecideHooks.push(hook);
    } else if (hook instanceof PostToolCallHook) {
      this.#postToolCallHooks.push(hook);
    } else if (hook instanceof OnToolErrorHook) {
      this.#onToolErrorHooks.push(hook);
    } else if (hook instanceof OnInteractionHook) {
      this.#onInteractionHooks.push(hook);
    } else if (hook instanceof OnCompactionHook) {
      this.#onCompactionHooks.push(hook);
    } else {
      const hookType = hook && typeof hook === "object" ? hook.constructor.name : typeof hook;
      throw new AntigravityValidationError(`Unknown hook type: ${hookType}`);
    }
  }

  register_hook(hook: Hook): void {
    this.registerHook(hook);
  }

  replacePreToolCallDecideHook(
    predicate: (hook: PreToolCallDecideHook) => boolean,
    replacement: PreToolCallDecideHook,
  ): boolean {
    const index = this.#preToolCallDecideHooks.findIndex(predicate);
    if (index === -1) {
      return false;
    }
    this.#preToolCallDecideHooks[index] = replacement;
    return true;
  }

  async dispatchSessionStart(): Promise<void> {
    for (const hook of this.#onSessionStartHooks) {
      await hook.run(this.sessionContext, undefined);
    }
  }

  dispatch_session_start(): Promise<void> {
    return this.dispatchSessionStart();
  }

  async dispatchSessionEnd(): Promise<void> {
    for (const hook of this.#onSessionEndHooks) {
      await hook.run(this.sessionContext, undefined);
    }
  }

  dispatch_session_end(): Promise<void> {
    return this.dispatchSessionEnd();
  }

  async dispatchPreTurn(prompt: Content | undefined): Promise<[HookResult, TurnContext]> {
    const turnContext = new TurnContext(this.sessionContext);
    for (const hook of this.#preTurnHooks) {
      const result = await hook.run(turnContext, prompt ?? "");
      if (!result.allow) {
        return [result, turnContext];
      }
    }
    return [new HookResult({ allow: true }), turnContext];
  }

  dispatch_pre_turn(prompt: Content | undefined): Promise<[HookResult, TurnContext]> {
    return this.dispatchPreTurn(prompt);
  }

  async dispatchPostTurn(turnContext: TurnContext, response: string): Promise<void> {
    for (const hook of this.#postTurnHooks) {
      await hook.run(turnContext, response);
    }
  }

  dispatch_post_turn(turnContext: TurnContext, response: string): Promise<void> {
    return this.dispatchPostTurn(turnContext, response);
  }

  async dispatchPreToolCall(
    turnContext: TurnContext,
    toolCall: ToolCall,
  ): Promise<[HookResult, ToolCall, OperationContext]> {
    const opContext = new OperationContext(turnContext);
    for (const hook of this.#preToolCallDecideHooks) {
      const result = await hook.run(opContext, toolCall);
      if (!result.allow) {
        return [result, toolCall, opContext];
      }
    }
    return [new HookResult({ allow: true }), toolCall, opContext];
  }

  dispatch_pre_tool_call(
    turnContext: TurnContext,
    toolCall: ToolCall,
  ): Promise<[HookResult, ToolCall, OperationContext]> {
    return this.dispatchPreToolCall(turnContext, toolCall);
  }

  async dispatchPostToolCall(opContext: OperationContext, result: ToolResult): Promise<void> {
    for (const hook of this.#postToolCallHooks) {
      await hook.run(opContext, result);
    }
  }

  dispatch_post_tool_call(opContext: OperationContext, result: ToolResult): Promise<void> {
    return this.dispatchPostToolCall(opContext, result);
  }

  async dispatchOnToolError(
    opContext: OperationContext,
    error: Error,
  ): Promise<[HookResult, unknown]> {
    for (const hook of this.#onToolErrorHooks) {
      try {
        const result = await hook.run(opContext, error);
        if (result !== undefined && result !== null) {
          return [new HookResult({ allow: true }), result];
        }
      } catch (recoveryError) {
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

  dispatch_on_tool_error(
    opContext: OperationContext,
    error: Error,
  ): Promise<[HookResult, unknown]> {
    return this.dispatchOnToolError(opContext, error);
  }

  async dispatchInteraction(
    turnContext: TurnContext,
    interactionSpec: import("../types.js").AskQuestionInteractionSpec,
  ): Promise<[HookResult, unknown, OperationContext]> {
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

  dispatch_interaction(
    turnContext: TurnContext,
    interactionSpec: import("../types.js").AskQuestionInteractionSpec,
  ): Promise<[HookResult, unknown, OperationContext]> {
    return this.dispatchInteraction(turnContext, interactionSpec);
  }

  async dispatchCompaction(turnContext: TurnContext, data: unknown): Promise<void> {
    const opContext = new OperationContext(turnContext);
    for (const hook of this.#onCompactionHooks) {
      await hook.run(opContext, data);
    }
  }

  dispatch_compaction(turnContext: TurnContext, data: unknown): Promise<void> {
    return this.dispatchCompaction(turnContext, data);
  }
}
