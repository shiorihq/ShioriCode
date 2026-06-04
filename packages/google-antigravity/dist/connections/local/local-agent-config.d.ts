import { GeminiConfig, type GeminiConfigInit } from "../../types.js";
import { AgentConfig, AgentConfigInit, CreateStrategyArgs, ConnectionStrategy } from "../connection.js";
export type LocalAgentConfigInit = AgentConfigInit & {
    geminiConfig?: GeminiConfig | GeminiConfigInit;
    gemini_config?: GeminiConfig | GeminiConfigInit;
    model?: string;
    apiKey?: string;
    api_key?: string;
    vertex?: boolean;
    project?: string;
    location?: string;
    runtimePath?: string;
    runtime_path?: string;
};
export declare class LocalAgentConfig extends AgentConfig {
    #private;
    geminiConfig: GeminiConfig;
    model?: string;
    apiKey?: string;
    vertex?: boolean;
    project?: string;
    location?: string;
    runtimePath?: string;
    constructor(init?: LocalAgentConfigInit);
    get gemini_config(): GeminiConfig;
    set gemini_config(value: GeminiConfig | GeminiConfigInit);
    get api_key(): string | undefined;
    set api_key(value: string | undefined);
    get runtime_path(): string | undefined;
    set runtime_path(value: string | undefined);
    createStrategy(args: CreateStrategyArgs): ConnectionStrategy;
    clone(): LocalAgentConfig;
}
//# sourceMappingURL=local-agent-config.d.ts.map