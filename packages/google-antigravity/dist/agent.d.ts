import { AgentConfig } from "./connections/connection.js";
import { Conversation } from "./conversation/conversation.js";
import * as policy from "./hooks/policy.js";
import { ChatResponse, Content } from "./types.js";
export declare class Agent implements AsyncDisposable {
    #private;
    constructor(config: AgentConfig);
    static start(config: AgentConfig): Promise<Agent>;
    static using<T>(config: AgentConfig, callback: (agent: Agent) => T | Promise<T>): Promise<T>;
    registerHook(hook: unknown): void;
    register_hook(hook: unknown): void;
    registerTrigger(trigger: import("./triggers/triggers.js").Trigger): void;
    register_trigger(trigger: import("./triggers/triggers.js").Trigger): void;
    upgradeRunCommandConfirmation(handler: policy.AskUserHandler): void;
    start(): Promise<this>;
    stop(): Promise<void>;
    dispose(excType?: unknown, excValue?: unknown, excTraceback?: unknown): Promise<void>;
    [Symbol.asyncDispose](): Promise<void>;
    chat(prompt: Content): Promise<ChatResponse>;
    get isStarted(): boolean;
    get is_started(): boolean;
    get conversation(): Conversation;
    get conversationId(): string | undefined;
    get conversation_id(): string | undefined;
}
//# sourceMappingURL=agent.d.ts.map