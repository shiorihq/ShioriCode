import { ToolCall, ToolResult, TypeScriptTool } from "../types.js";
import { ToolContext } from "./tool-context.js";
export declare class ToolWithSchema {
    fn: TypeScriptTool;
    inputSchema: Record<string, unknown>;
    name: string;
    description: string;
    __name__: string;
    __doc__: string;
    constructor(fn: TypeScriptTool, inputSchema: Record<string, unknown>, name?: string, description?: string);
    get input_schema(): Record<string, unknown>;
    set input_schema(value: Record<string, unknown>);
    call(...args: unknown[]): unknown | Promise<unknown>;
}
type RegisteredTool = TypeScriptTool | ToolWithSchema;
export type PublicToolCallable = TypeScriptTool & {
    inputSchema?: Record<string, unknown>;
    parameterNames?: string[];
    description?: string;
};
export declare class ToolRunner {
    #private;
    constructor(tools?: RegisteredTool[]);
    setContext(ctx: ToolContext): void;
    set_context(ctx: ToolContext): void;
    register(tool: RegisteredTool, name?: string): void;
    unregister(name: string): void;
    get toolNames(): string[];
    get tool_names(): string[];
    get tools(): Record<string, RegisteredTool>;
    getPublicCallable(toolName: string): RegisteredTool | PublicToolCallable;
    get_public_callable(toolName: string): RegisteredTool | PublicToolCallable;
    getPublicInputSchema(toolName: string): Record<string, unknown>;
    get_public_input_schema(toolName: string): Record<string, unknown>;
    getPublicParameterNames(toolName: string): string[];
    get_public_parameter_names(toolName: string): string[];
    getToolDescription(toolName: string): string;
    get_tool_description(toolName: string): string;
    execute(toolName: string, args?: Record<string, unknown>): Promise<unknown>;
    processToolCalls(toolCalls: ToolCall[]): Promise<ToolResult[]>;
    process_tool_calls(toolCalls: ToolCall[]): Promise<ToolResult[]>;
}
export {};
//# sourceMappingURL=tool-runner.d.ts.map