import { Conversation } from "./conversation/conversation.js";
import { HookRunner } from "./hooks/hook-runner.js";
import * as policy from "./hooks/policy.js";
import { McpBridge } from "./mcp/bridge.js";
import { ToolContext } from "./tools/tool-context.js";
import { ToolRunner } from "./tools/tool-runner.js";
import { TriggerRunner } from "./triggers/trigger-runner.js";
import { BuiltinTools, CapabilitiesConfig, } from "./types.js";
export class Agent {
    #config;
    #strategy;
    #conversation;
    #toolRunner;
    #hookRunner;
    #mcpBridge;
    #triggerRunner;
    #pendingHooks;
    #pendingTriggers;
    constructor(config) {
        this.#config = config.clone();
        if (this.#config.responseSchema) {
            this.#config.capabilities.finishToolSchemaJson = this.#config.responseSchema;
        }
        this.#pendingHooks = [...config.hooks];
        this.#pendingTriggers = [...config.triggers];
    }
    static async start(config) {
        const agent = new Agent(config);
        await agent.start();
        return agent;
    }
    static async using(config, callback) {
        const agent = await Agent.start(config);
        let callbackFailed = false;
        try {
            return await callback(agent);
        }
        catch (error) {
            callbackFailed = true;
            await agent.dispose(error instanceof Error ? error.constructor : undefined, error);
            throw error;
        }
        finally {
            if (!callbackFailed) {
                await agent.dispose();
            }
        }
    }
    registerHook(hook) {
        if (!this.#hookRunner) {
            this.#pendingHooks.push(hook);
            return;
        }
        this.#hookRunner.registerHook(hook);
    }
    register_hook(hook) {
        this.registerHook(hook);
    }
    registerTrigger(trigger) {
        if (this.#conversation) {
            throw new Error("Cannot register triggers after the agent has started.");
        }
        this.#pendingTriggers.push(trigger);
    }
    register_trigger(trigger) {
        this.registerTrigger(trigger);
    }
    upgradeRunCommandConfirmation(handler) {
        if (!this.#hookRunner) {
            throw new Error("Agent session not started. Use 'await Agent.start(...)'.");
        }
        const upgraded = this.#config.policies.map((entry) => this.#upgradePolicyEntry(entry, handler));
        this.#config.policies = upgraded;
        const replacement = policy.enforce(upgraded, {
            mcpServers: this.#config.mcpServers,
        });
        const replaced = this.#hookRunner.replacePreToolCallDecideHook((hook) => hook instanceof policy.PolicyDecideHook, replacement);
        if (!replaced) {
            this.#hookRunner.registerHook(replacement);
        }
    }
    #upgradePolicyEntry(entry, handler) {
        if (entry instanceof policy.Policy) {
            if (String(entry.tool) === BuiltinTools.RUN_COMMAND &&
                entry.decision === policy.Decision.DENY &&
                entry.when === undefined) {
                return policy.askUser(BuiltinTools.RUN_COMMAND, {
                    handler,
                    name: entry.name || "interactive_confirm",
                });
            }
            return entry;
        }
        if (Array.isArray(entry)) {
            return entry.map((item) => this.#upgradePolicyEntry(item, handler));
        }
        return entry;
    }
    async start() {
        try {
            this.#hookRunner = new HookRunner();
            for (const hook of this.#pendingHooks) {
                this.#hookRunner.registerHook(hook);
            }
            this.#pendingHooks = [];
            this.#applyPolicies();
            let allTools = [...this.#config.tools];
            if (this.#config.mcpServers.length) {
                this.#mcpBridge = new McpBridge();
                for (const serverConfig of this.#config.mcpServers) {
                    await this.#mcpBridge.connect(serverConfig);
                }
                allTools = [...allTools, ...this.#mcpBridge.tools];
            }
            this.#toolRunner = new ToolRunner(allTools);
            this.#strategy = this.#config.createStrategy({
                toolRunner: this.#toolRunner,
                hookRunner: this.#hookRunner,
            });
            this.#conversation = await Conversation.create(this.#strategy);
            if (this.#pendingTriggers.length) {
                this.#triggerRunner = new TriggerRunner({
                    triggers: [...this.#pendingTriggers],
                    connection: this.conversation.connection,
                });
                await this.#triggerRunner.start();
                this.#pendingTriggers = [];
            }
            this.#toolRunner.setContext(new ToolContext(this.conversation.connection));
            return this;
        }
        catch (error) {
            await this.#cleanupFailedStart();
            throw error;
        }
    }
    #applyPolicies() {
        if (!this.#hookRunner) {
            return;
        }
        const cfg = this.#config.capabilities ?? new CapabilitiesConfig();
        const readOnlyTools = new Set(BuiltinTools.readOnly());
        let activeTools;
        if (cfg.enabledTools !== undefined) {
            activeTools = new Set(cfg.enabledTools.map(String));
        }
        else if (cfg.disabledTools !== undefined) {
            activeTools = new Set(BuiltinTools.allTools()
                .map(String)
                .filter((tool) => !cfg.disabledTools.map(String).includes(tool)));
        }
        else {
            activeTools = new Set(BuiltinTools.allTools().map(String));
        }
        const hasWriteTools = [...activeTools].some((tool) => !readOnlyTools.has(tool));
        const hasMcpServers = this.#config.mcpServers.length > 0;
        const hasToolDecideHook = this.#hookRunner.preToolCallDecideHooks.length > 0;
        if ((hasWriteTools || hasMcpServers) && !this.#config.policies.length && !hasToolDecideHook) {
            throw new Error("Write tools or MCP servers are enabled without a safety policy. Add policies=[policy.allowAll()] to approve all tool calls, or policies=[policy.denyAll(), policy.allow('tool_name')] to selectively allow specific tools.");
        }
        if (this.#config.policies.length) {
            this.#hookRunner.registerHook(policy.enforce(this.#config.policies, {
                mcpServers: this.#config.mcpServers,
            }));
        }
    }
    async stop() {
        await this.dispose();
    }
    async dispose(excType, excValue, excTraceback) {
        await this.#triggerRunner?.stop();
        await this.#strategy?.stop(excType, excValue, excTraceback);
        await this.#mcpBridge?.stop();
        this.#triggerRunner = undefined;
        this.#strategy = undefined;
        this.#mcpBridge = undefined;
        this.#toolRunner = undefined;
        this.#hookRunner = undefined;
        this.#conversation = undefined;
    }
    async #cleanupFailedStart() {
        if (this.#conversation || this.#triggerRunner) {
            await this.stop();
        }
        else {
            await this.#mcpBridge?.stop();
            this.#mcpBridge = undefined;
            this.#strategy = undefined;
        }
    }
    async [Symbol.asyncDispose]() {
        await this.dispose();
    }
    async chat(prompt) {
        return await this.conversation.chat(prompt);
    }
    get isStarted() {
        return this.#conversation !== undefined;
    }
    get is_started() {
        return this.isStarted;
    }
    get conversation() {
        if (!this.#conversation) {
            throw new Error("Agent session not started. Use 'await Agent.start(...)'.");
        }
        return this.#conversation;
    }
    get conversationId() {
        return this.#conversation?.conversationId || undefined;
    }
    get conversation_id() {
        return this.conversationId;
    }
}
//# sourceMappingURL=agent.js.map