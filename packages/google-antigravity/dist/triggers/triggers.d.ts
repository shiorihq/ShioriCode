import { Connection } from "../connections/connection.js";
export declare class TriggerContext {
    #private;
    readonly signal: AbortSignal;
    constructor(connection: Connection, signal?: AbortSignal);
    send(content: string): Promise<void>;
}
export type Trigger = (ctx: TriggerContext) => Promise<void>;
export declare function trigger(fn: Trigger): Trigger;
//# sourceMappingURL=triggers.d.ts.map