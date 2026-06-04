import { Connection } from "../connections/connection.js";
import { Trigger } from "./triggers.js";
type TriggerRunnerInit = {
    triggers: Trigger[];
    connection: Connection;
};
export declare class TriggerRunner implements AsyncDisposable {
    #private;
    constructor(init: TriggerRunnerInit);
    constructor(triggers: Trigger[], connection: Connection);
    static start(init: TriggerRunnerInit): Promise<TriggerRunner>;
    static using<T>(init: TriggerRunnerInit, callback: (runner: TriggerRunner) => T | Promise<T>): Promise<T>;
    start(): Promise<void>;
    stop(): Promise<void>;
    get isRunning(): boolean;
    get is_running(): boolean;
    [Symbol.asyncDispose](): Promise<void>;
}
export {};
//# sourceMappingURL=trigger-runner.d.ts.map