import { Connection } from "../connections/connection.js";
export declare class ToolContext {
    #private;
    constructor(connection: Connection);
    get conversationId(): string;
    get conversation_id(): string;
    get isIdle(): boolean;
    get is_idle(): boolean;
    send(message: string): Promise<void>;
    getState<T = unknown>(key: string, defaultValue?: T): T | undefined;
    get_state<T = unknown>(key: string, defaultValue?: T): T | undefined;
    setState(key: string, value: unknown): void;
    set_state(key: string, value: unknown): void;
}
//# sourceMappingURL=tool-context.d.ts.map