import { BaseMcpServerConfig, HookResult, ToolCall } from "../types.js";
import { PreToolCallDecideHook, HookContext } from "./hooks.js";
export type Predicate = ((args: Record<string, unknown>) => boolean | Promise<boolean>) | ((toolCall: ToolCall) => boolean | Promise<boolean>);
export type AskUserHandler = (toolCall: ToolCall) => boolean | Promise<boolean>;
type PolicyOptions = {
    when?: Predicate;
    name?: string;
};
type AskUserOptions = PolicyOptions & {
    handler: AskUserHandler;
};
type EnforceOptions = {
    mcpServers?: BaseMcpServerConfig[];
    mcp_servers?: BaseMcpServerConfig[];
};
export declare enum Decision {
    APPROVE = "APPROVE",
    DENY = "DENY",
    ASK_USER = "ASK_USER"
}
export declare class Policy {
    tool: string;
    decision: Decision;
    when?: Predicate;
    askUser?: AskUserHandler;
    name: string;
    constructor(init: {
        tool: string;
        decision: Decision;
        when?: Predicate;
        askUser?: AskUserHandler;
        ask_user?: AskUserHandler;
        name?: string;
    });
    get ask_user(): AskUserHandler | undefined;
    set ask_user(value: AskUserHandler | undefined);
}
export declare function allow(tool: string, options?: PolicyOptions): Policy;
export declare function allow(mcpConfig: BaseMcpServerConfig, mcpTools?: string[], options?: PolicyOptions): Policy[];
export declare function allow(mcpConfig: BaseMcpServerConfig, options?: PolicyOptions): Policy[];
export declare function deny(tool: string, options?: PolicyOptions): Policy;
export declare function deny(mcpConfig: BaseMcpServerConfig, mcpTools?: string[], options?: PolicyOptions): Policy[];
export declare function deny(mcpConfig: BaseMcpServerConfig, options?: PolicyOptions): Policy[];
export declare function askUser(tool: string, options: AskUserOptions): Policy;
export declare function askUser(mcpConfig: BaseMcpServerConfig, mcpTools: string[] | undefined, options: AskUserOptions): Policy[];
export declare function askUser(mcpConfig: BaseMcpServerConfig, options: AskUserOptions): Policy[];
export declare function allowAll(): Policy;
export declare const allow_all: typeof allowAll;
export declare function safeDefaults(handler: AskUserHandler): Policy[];
export declare const safe_defaults: typeof safeDefaults;
export declare function denyAll(): Policy;
export declare const deny_all: typeof denyAll;
export declare function confirmRunCommand(handler?: AskUserHandler): Policy[];
export declare const ask_user: typeof askUser;
export declare const confirm_run_command: typeof confirmRunCommand;
export declare function isPathInWorkspace(targetPath: string, workspacePath: string): boolean;
export declare const is_path_in_workspace: typeof isPathInWorkspace;
export declare function workspaceOnly(workspaces: Array<string | URL>): Policy[];
export declare const workspace_only: typeof workspaceOnly;
export declare class PolicyDecideHook extends PreToolCallDecideHook {
    #private;
    constructor(buckets: Policy[][], serverNames: string[]);
    run(_context: HookContext, data: ToolCall): Promise<HookResult>;
}
export declare function enforce(policies: Array<Policy | Policy[]>, options?: EnforceOptions): PreToolCallDecideHook;
export {};
//# sourceMappingURL=policy.d.ts.map