import { type ChildProcessWithoutNullStreams } from "node:child_process";
import { CapabilitiesConfig, Content, CustomSystemInstructions, GeminiConfig, TemplatedSystemInstructions, Step, ToolResult } from "../../types.js";
import { Connection, ConnectionStrategy } from "../connection.js";
import { ToolRunner, ToolWithSchema } from "../../tools/tool-runner.js";
import { HookRunner } from "../../hooks/hook-runner.js";
export type LocalConnectionStrategyInit = {
    runtimePath?: string;
    runtime_path?: string;
    conversationId?: string;
    conversation_id?: string;
    toolRunner?: ToolRunner;
    tool_runner?: ToolRunner;
    hookRunner?: HookRunner;
    hook_runner?: HookRunner;
    geminiConfig?: GeminiConfig | string;
    gemini_config?: GeminiConfig | string;
    skillsPaths?: string[];
    skills_paths?: string[];
    systemInstructions?: string | CustomSystemInstructions | TemplatedSystemInstructions;
    system_instructions?: string | CustomSystemInstructions | TemplatedSystemInstructions;
    capabilitiesConfig?: CapabilitiesConfig;
    capabilities_config?: CapabilitiesConfig;
    saveDir?: string;
    save_dir?: string;
    workspaces?: string[];
    appDataDir?: string;
    app_data_dir?: string;
};
export declare function normalizeWirePath(path: string): string;
export declare const normalize_wire_path: typeof normalizeWirePath;
type StepUpdateObject = Record<string, unknown>;
export declare class LocalConnectionStep extends Step {
    cascadeId: string;
    trajectoryId: string;
    httpCode: number;
    constructor(init?: Partial<LocalConnectionStep>);
    get cascade_id(): string;
    set cascade_id(value: string);
    get trajectory_id(): string;
    set trajectory_id(value: string);
    get http_code(): number;
    set http_code(value: number);
    static fromObject(stepObject: StepUpdateObject): LocalConnectionStep;
    static from_dict(stepObject: StepUpdateObject): LocalConnectionStep;
    static fromOutputEvent(event: Record<string, unknown>): LocalConnectionStep | undefined;
    static from_output_event(event: Record<string, unknown>): LocalConnectionStep | undefined;
}
export type LocalHarnessToolProto = {
    name: string;
    description: string;
    parameters_json_schema: string;
};
export declare function callableToToolProto(fn: import("../../types.js").TypeScriptTool | ToolWithSchema, toolRunner?: ToolRunner): LocalHarnessToolProto;
export declare const callable_to_tool_proto: typeof callableToToolProto;
export declare class LocalConnection implements Connection {
    #private;
    constructor(init: {
        process: ChildProcessWithoutNullStreams;
        ws: WebSocket;
        toolRunner?: ToolRunner;
        hookRunner?: HookRunner;
        conversationId?: string;
    });
    get isIdle(): boolean;
    get is_idle(): boolean;
    get conversationId(): string;
    get conversation_id(): string;
    send(prompt: Content | undefined): Promise<void>;
    receiveSteps(): AsyncIterable<Step>;
    receive_steps(): AsyncIterable<Step>;
    disconnect(): Promise<void>;
    cancel(): Promise<void>;
    delete(): Promise<void>;
    signalIdle(): Promise<void>;
    signal_idle(): Promise<void>;
    waitForIdle(): Promise<void>;
    wait_for_idle(): Promise<void>;
    waitForWakeup(_timeout?: number): Promise<boolean>;
    wait_for_wakeup(timeout?: number): Promise<boolean>;
    sendToolResults(results: ToolResult[]): Promise<void>;
    send_tool_results(results: ToolResult[]): Promise<void>;
    sendTriggerNotification(content: string): Promise<void>;
    send_trigger_notification(content: string): Promise<void>;
}
export declare class LocalConnectionStrategy extends ConnectionStrategy {
    #private;
    constructor(init?: LocalConnectionStrategyInit);
    connect(): Connection;
    start(): Promise<void>;
    stop(): Promise<void>;
}
export declare function discoverLocalHarness(explicitPath?: string): string | undefined;
export declare const discover_local_harness: typeof discoverLocalHarness;
export {};
//# sourceMappingURL=local-connection.d.ts.map