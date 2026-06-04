import { existsSync, realpathSync } from "node:fs";
import { isAbsolute, join, parse, relative, resolve, sep } from "node:path";
import { platform } from "node:os";
import { fileURLToPath } from "node:url";
import { BuiltinTools, HookResult } from "../types.js";
import { PreToolCallDecideHook } from "./hooks.js";
const WILDCARD = "*";
export var Decision;
(function (Decision) {
    Decision["APPROVE"] = "APPROVE";
    Decision["DENY"] = "DENY";
    Decision["ASK_USER"] = "ASK_USER";
})(Decision || (Decision = {}));
export class Policy {
    tool;
    decision;
    when;
    askUser;
    name = "";
    constructor(init) {
        this.tool = init.tool;
        this.decision = init.decision;
        this.when = init.when;
        this.askUser = init.askUser ?? init.ask_user;
        this.name = init.name ?? "";
    }
    get ask_user() {
        return this.askUser;
    }
    set ask_user(value) {
        this.askUser = value;
    }
}
function mcpPolicies(decision, mcpConfig, mcpTools, options = {}) {
    const server = mcpConfig.name;
    if (mcpTools === undefined) {
        return [
            new Policy({
                tool: `${server}/*`,
                decision,
                when: options.when,
                name: options.name ?? `${decision.toLowerCase()}_${server}_all`,
                askUser: options.handler,
            }),
        ];
    }
    return mcpTools.map((tool) => new Policy({
        tool: `${server}/${tool}`,
        decision,
        when: options.when,
        name: options.name
            ? `${options.name}_${tool}`
            : `${decision.toLowerCase()}_${server}_${tool}`,
        askUser: options.handler,
    }));
}
function normalizePolicyArgs(mcpToolsOrOptions, options = {}) {
    if (typeof mcpToolsOrOptions === "string") {
        throw new Error(`mcpTools must be a sequence of strings, not a single string '${mcpToolsOrOptions}'.`);
    }
    if (Array.isArray(mcpToolsOrOptions) || mcpToolsOrOptions === undefined) {
        return { mcpTools: mcpToolsOrOptions, options };
    }
    return { options: mcpToolsOrOptions };
}
function normalizeAskUserArgs(mcpToolsOrOptions, options) {
    if (typeof mcpToolsOrOptions === "string") {
        throw new Error(`mcpTools must be a sequence of strings, not a single string '${mcpToolsOrOptions}'.`);
    }
    if (Array.isArray(mcpToolsOrOptions) || mcpToolsOrOptions === undefined) {
        if (!options) {
            throw new Error("askUser requires a handler option.");
        }
        return { mcpTools: mcpToolsOrOptions, options };
    }
    return { options: mcpToolsOrOptions };
}
export function allow(toolOrMcp, mcpToolsOrOptions, maybeOptions = {}) {
    const { mcpTools, options } = normalizePolicyArgs(mcpToolsOrOptions, maybeOptions);
    if (typeof toolOrMcp === "string") {
        if (mcpTools !== undefined) {
            throw new Error("mcpTools cannot be specified when tool is a string.");
        }
        return new Policy({
            tool: toolOrMcp,
            decision: Decision.APPROVE,
            when: options.when,
            name: options.name,
        });
    }
    return mcpPolicies(Decision.APPROVE, toolOrMcp, mcpTools, options);
}
export function deny(toolOrMcp, mcpToolsOrOptions, maybeOptions = {}) {
    const { mcpTools, options } = normalizePolicyArgs(mcpToolsOrOptions, maybeOptions);
    if (typeof toolOrMcp === "string") {
        if (mcpTools !== undefined) {
            throw new Error("mcpTools cannot be specified when tool is a string.");
        }
        return new Policy({
            tool: toolOrMcp,
            decision: Decision.DENY,
            when: options.when,
            name: options.name,
        });
    }
    return mcpPolicies(Decision.DENY, toolOrMcp, mcpTools, options);
}
export function askUser(toolOrMcp, mcpToolsOrOptions, maybeOptions) {
    const { mcpTools, options } = normalizeAskUserArgs(mcpToolsOrOptions, maybeOptions);
    if (typeof toolOrMcp === "string") {
        if (mcpTools !== undefined) {
            throw new Error("mcpTools cannot be specified when tool is a string.");
        }
        return new Policy({
            tool: toolOrMcp,
            decision: Decision.ASK_USER,
            when: options.when,
            askUser: options.handler,
            name: options.name,
        });
    }
    return mcpPolicies(Decision.ASK_USER, toolOrMcp, mcpTools, {
        ...options,
        handler: options.handler,
    });
}
export function allowAll() {
    return allow(WILDCARD, { name: "allow_all" });
}
export const allow_all = allowAll;
export function safeDefaults(handler) {
    return [
        ...BuiltinTools.readOnly().map((tool) => allow(tool)),
        askUser(WILDCARD, { handler }),
    ];
}
export const safe_defaults = safeDefaults;
export function denyAll() {
    return deny(WILDCARD, { name: "deny_all" });
}
export const deny_all = denyAll;
export function confirmRunCommand(handler) {
    if (handler) {
        return [
            askUser(BuiltinTools.RUN_COMMAND, {
                handler,
                name: "confirm_run_command",
            }),
            allow(WILDCARD, { name: "confirm_run_command" }),
        ];
    }
    return [
        deny(BuiltinTools.RUN_COMMAND, {
            name: "confirm_run_command",
        }),
        allow(WILDCARD, { name: "confirm_run_command" }),
    ];
}
export const ask_user = askUser;
export const confirm_run_command = confirmRunCommand;
function normalizePath(path) {
    const absolutePath = resolve(path);
    try {
        return realpathSync.native(absolutePath);
    }
    catch {
        return resolveExistingPrefix(absolutePath);
    }
}
function resolveExistingPrefix(absolutePath) {
    const parsed = parse(absolutePath);
    const segments = absolutePath.slice(parsed.root.length).split(sep).filter(Boolean);
    let current = parsed.root;
    for (let index = 0; index < segments.length; index += 1) {
        const candidate = join(current, segments[index]);
        if (!existsSync(candidate)) {
            return join(current, ...segments.slice(index));
        }
        current = realpathSync.native(candidate);
    }
    return current;
}
function isCaseInsensitive() {
    return platform() === "darwin" || platform() === "win32";
}
export function isPathInWorkspace(targetPath, workspacePath) {
    try {
        let target = normalizePath(targetPath);
        let workspace = normalizePath(workspacePath);
        if (isCaseInsensitive()) {
            target = target.toLocaleLowerCase();
            workspace = workspace.toLocaleLowerCase();
        }
        const relativePath = relative(workspace, target);
        return relativePath === "" || (!relativePath.startsWith("..") && !isAbsolute(relativePath));
    }
    catch {
        return false;
    }
}
export const is_path_in_workspace = isPathInWorkspace;
export function workspaceOnly(workspaces) {
    const workspaceStrings = workspaces.map((workspace) => workspace instanceof URL ? fileURLToPath(workspace) : workspace);
    return BuiltinTools.fileTools().map((tool) => deny(tool, {
        name: "workspace_only",
        when: ((call) => {
            const path = call.canonicalPath ?? "";
            if (!path) {
                return false;
            }
            return !workspaceStrings.some((workspace) => isPathInWorkspace(path, workspace));
        }),
    }));
}
export const workspace_only = workspaceOnly;
const LEVEL_SPECIFIC_DENY = 0;
const LEVEL_SPECIFIC_ASK = 1;
const LEVEL_SPECIFIC_ALLOW = 2;
const LEVEL_PREFIX_DENY = 3;
const LEVEL_PREFIX_ASK = 4;
const LEVEL_PREFIX_ALLOW = 5;
const LEVEL_GLOBAL_DENY = 6;
const LEVEL_GLOBAL_ASK = 7;
const LEVEL_GLOBAL_ALLOW = 8;
const NUM_LEVELS = 9;
function bucketIndex(policy) {
    const isGlobal = policy.tool === WILDCARD;
    const isPrefix = policy.tool.endsWith("/*");
    if (isGlobal) {
        return {
            [Decision.DENY]: LEVEL_GLOBAL_DENY,
            [Decision.ASK_USER]: LEVEL_GLOBAL_ASK,
            [Decision.APPROVE]: LEVEL_GLOBAL_ALLOW,
        }[policy.decision];
    }
    if (isPrefix) {
        return {
            [Decision.DENY]: LEVEL_PREFIX_DENY,
            [Decision.ASK_USER]: LEVEL_PREFIX_ASK,
            [Decision.APPROVE]: LEVEL_PREFIX_ALLOW,
        }[policy.decision];
    }
    return {
        [Decision.DENY]: LEVEL_SPECIFIC_DENY,
        [Decision.ASK_USER]: LEVEL_SPECIFIC_ASK,
        [Decision.APPROVE]: LEVEL_SPECIFIC_ALLOW,
    }[policy.decision];
}
function matchesTarget(policyTool, callTarget, isMcp) {
    if (policyTool === WILDCARD) {
        return true;
    }
    if (isMcp) {
        if (policyTool.endsWith("/*")) {
            const policyServer = policyTool.slice(0, -2);
            const [callServer] = callTarget.split("/", 1);
            return policyServer === callServer;
        }
        return policyTool === callTarget;
    }
    return policyTool === callTarget;
}
async function evaluatePredicate(policy, toolCall) {
    if (!policy.when) {
        return true;
    }
    const source = policy.when.toString();
    const hasNoParameters = /^\s*(?:async\s*)?(?:function\b[^(]*\(\s*\)|\(\s*\)\s*=>)/.test(source);
    if (hasNoParameters) {
        return Boolean(await policy.when());
    }
    const wantsToolCall = source.includes("ToolCall") || /^\s*(?:async\s*)?\(?\s*(?:toolCall|tc|call)\b/.test(source);
    const result = wantsToolCall
        ? await policy.when(toolCall)
        : await policy.when(toolCall.args);
    return Boolean(result);
}
function reprError(error) {
    if (error instanceof Error) {
        const name = error.name || "Error";
        const message = error.message.replace(/\\/g, "\\\\").replace(/'/g, "\\'");
        return `${name}('${message}')`;
    }
    return String(error);
}
export class PolicyDecideHook extends PreToolCallDecideHook {
    #buckets;
    #serverNames;
    constructor(buckets, serverNames) {
        super();
        this.#buckets = buckets;
        this.#serverNames = [...serverNames].sort((a, b) => b.length - a.length);
    }
    #parseMcpTool(toolName) {
        if (!toolName.startsWith("mcp_")) {
            return undefined;
        }
        const rest = toolName.slice(4);
        for (const server of this.#serverNames) {
            if (rest.startsWith(`${server}_`)) {
                return [server, rest.slice(server.length + 1)];
            }
        }
        return undefined;
    }
    async #evaluatePolicy(policy, toolCall) {
        const mcpInfo = this.#parseMcpTool(String(toolCall.name));
        const callTarget = mcpInfo ? `${mcpInfo[0]}/${mcpInfo[1]}` : String(toolCall.name);
        const isMcp = mcpInfo !== undefined;
        if (!matchesTarget(policy.tool, callTarget, isMcp)) {
            return undefined;
        }
        try {
            if (!(await evaluatePredicate(policy, toolCall))) {
                return undefined;
            }
            return await this.#apply(policy, toolCall);
        }
        catch (error) {
            return new HookResult({
                allow: false,
                message: `Policy evaluation failed for policy '${policy.name || policy.tool}': ${reprError(error)}`,
            });
        }
    }
    async run(_context, data) {
        for (const bucket of this.#buckets) {
            for (const policy of bucket) {
                const result = await this.#evaluatePolicy(policy, data);
                if (result) {
                    return result;
                }
            }
        }
        return new HookResult({ allow: true });
    }
    async #apply(policy, toolCall) {
        const label = policy.name || policy.tool;
        if (policy.decision === Decision.DENY) {
            return new HookResult({
                allow: false,
                message: `Denied by policy '${label}'.`,
            });
        }
        if (policy.decision === Decision.APPROVE) {
            return new HookResult({ allow: true });
        }
        if (!policy.askUser) {
            throw new Error("ASK_USER policy is missing an ask_user handler.");
        }
        const approved = await policy.askUser(toolCall);
        return approved
            ? new HookResult({ allow: true })
            : new HookResult({
                allow: false,
                message: `User denied tool '${toolCall.name}' (policy '${label}').`,
            });
    }
}
function flattenPolicies(policies) {
    return policies.flatMap((policy) => {
        if (policy instanceof Policy) {
            return [policy];
        }
        if (Array.isArray(policy) && policy.every((entry) => entry instanceof Policy)) {
            return policy;
        }
        throw new Error(`Expected Policy or Policy[], got ${typeof policy}`);
    });
}
export function enforce(policies, options = {}) {
    const flatPolicies = flattenPolicies(policies);
    const mcpServers = options.mcpServers ?? options.mcp_servers ?? [];
    const hasMcpPolicy = flatPolicies.some((policy) => policy.tool.includes("/") && policy.tool !== WILDCARD);
    if (hasMcpPolicy && !mcpServers.length) {
        throw new Error("MCP policies (containing '/') were detected, but mcpServers was not provided to enforce().");
    }
    for (const policy of flatPolicies) {
        if (policy.decision === Decision.ASK_USER && !policy.askUser) {
            throw new Error(`ASK_USER policy '${policy.name || policy.tool}' is missing an ask_user handler. Provide one via policy.ask_user(tool, { handler }).`);
        }
    }
    const buckets = Array.from({ length: NUM_LEVELS }, () => []);
    for (const policy of flatPolicies) {
        buckets[bucketIndex(policy)].push(policy);
    }
    return new PolicyDecideHook(buckets, mcpServers.map((server) => server.name));
}
//# sourceMappingURL=policy.js.map