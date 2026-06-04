import { AgentConfig } from "./connections/connection.js";
import { Conversation } from "./conversation/conversation.js";
import { HookRunner } from "./hooks/hook-runner.js";
import * as policy from "./hooks/policy.js";
import { McpBridge } from "./mcp/bridge.js";
import { ToolContext } from "./tools/tool-context.js";
import { ToolRunner, ToolWithSchema } from "./tools/tool-runner.js";
import { TriggerRunner } from "./triggers/trigger-runner.js";
import {
  BuiltinTools,
  CapabilitiesConfig,
  ChatResponse,
  Content,
  TypeScriptTool,
} from "./types.js";

export class Agent implements AsyncDisposable {
  #config: AgentConfig;
  #strategy?: import("./connections/connection.js").ConnectionStrategy;
  #conversation?: Conversation;
  #toolRunner?: ToolRunner;
  #hookRunner?: HookRunner;
  #mcpBridge?: McpBridge;
  #triggerRunner?: TriggerRunner;
  #pendingHooks: unknown[];
  #pendingTriggers: import("./triggers/triggers.js").Trigger[];

  constructor(config: AgentConfig) {
    this.#config = config.clone();
    if (this.#config.responseSchema) {
      this.#config.capabilities.finishToolSchemaJson = this.#config.responseSchema;
    }
    this.#pendingHooks = [...config.hooks];
    this.#pendingTriggers = [...(config.triggers as import("./triggers/triggers.js").Trigger[])];
  }

  static async start(config: AgentConfig): Promise<Agent> {
    const agent = new Agent(config);
    await agent.start();
    return agent;
  }

  static async using<T>(
    config: AgentConfig,
    callback: (agent: Agent) => T | Promise<T>,
  ): Promise<T> {
    const agent = await Agent.start(config);
    let callbackFailed = false;
    try {
      return await callback(agent);
    } catch (error) {
      callbackFailed = true;
      await agent.dispose(error instanceof Error ? error.constructor : undefined, error);
      throw error;
    } finally {
      if (!callbackFailed) {
        await agent.dispose();
      }
    }
  }

  registerHook(hook: unknown): void {
    if (!this.#hookRunner) {
      this.#pendingHooks.push(hook);
      return;
    }
    this.#hookRunner.registerHook(hook as import("./hooks/hooks.js").Hook);
  }

  register_hook(hook: unknown): void {
    this.registerHook(hook);
  }

  registerTrigger(trigger: import("./triggers/triggers.js").Trigger): void {
    if (this.#conversation) {
      throw new Error("Cannot register triggers after the agent has started.");
    }
    this.#pendingTriggers.push(trigger);
  }

  register_trigger(trigger: import("./triggers/triggers.js").Trigger): void {
    this.registerTrigger(trigger);
  }

  upgradeRunCommandConfirmation(handler: policy.AskUserHandler): void {
    if (!this.#hookRunner) {
      throw new Error("Agent session not started. Use 'await Agent.start(...)'.");
    }
    const upgraded = this.#config.policies.map((entry) => this.#upgradePolicyEntry(entry, handler));
    this.#config.policies = upgraded;
    const replacement = policy.enforce(upgraded as Array<policy.Policy | policy.Policy[]>, {
      mcpServers: this.#config.mcpServers,
    });
    const replaced = this.#hookRunner.replacePreToolCallDecideHook(
      (hook) => hook instanceof policy.PolicyDecideHook,
      replacement,
    );
    if (!replaced) {
      this.#hookRunner.registerHook(replacement);
    }
  }

  #upgradePolicyEntry(entry: unknown, handler: policy.AskUserHandler): unknown {
    if (entry instanceof policy.Policy) {
      if (
        String(entry.tool) === BuiltinTools.RUN_COMMAND &&
        entry.decision === policy.Decision.DENY &&
        entry.when === undefined
      ) {
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

  async start(): Promise<this> {
    try {
      this.#hookRunner = new HookRunner();
      for (const hook of this.#pendingHooks) {
        this.#hookRunner.registerHook(hook as import("./hooks/hooks.js").Hook);
      }
      this.#pendingHooks = [];

      this.#applyPolicies();

      let allTools: Array<TypeScriptTool | ToolWithSchema> = [...this.#config.tools];
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
    } catch (error) {
      await this.#cleanupFailedStart();
      throw error;
    }
  }

  #applyPolicies(): void {
    if (!this.#hookRunner) {
      return;
    }
    const cfg = this.#config.capabilities ?? new CapabilitiesConfig();
    const readOnlyTools = new Set(BuiltinTools.readOnly());
    let activeTools: Set<string>;
    if (cfg.enabledTools !== undefined) {
      activeTools = new Set(cfg.enabledTools.map(String));
    } else if (cfg.disabledTools !== undefined) {
      activeTools = new Set(
        BuiltinTools.allTools()
          .map(String)
          .filter((tool) => !cfg.disabledTools!.map(String).includes(tool)),
      );
    } else {
      activeTools = new Set(BuiltinTools.allTools().map(String));
    }
    const hasWriteTools = [...activeTools].some((tool) => !readOnlyTools.has(tool as BuiltinTools));
    const hasMcpServers = this.#config.mcpServers.length > 0;
    const hasToolDecideHook = this.#hookRunner.preToolCallDecideHooks.length > 0;
    if ((hasWriteTools || hasMcpServers) && !this.#config.policies.length && !hasToolDecideHook) {
      throw new Error(
        "Write tools or MCP servers are enabled without a safety policy. Add policies=[policy.allowAll()] to approve all tool calls, or policies=[policy.denyAll(), policy.allow('tool_name')] to selectively allow specific tools.",
      );
    }
    if (this.#config.policies.length) {
      this.#hookRunner.registerHook(
        policy.enforce(this.#config.policies as Array<policy.Policy | policy.Policy[]>, {
          mcpServers: this.#config.mcpServers,
        }),
      );
    }
  }

  async stop(): Promise<void> {
    await this.dispose();
  }

  async dispose(excType?: unknown, excValue?: unknown, excTraceback?: unknown): Promise<void> {
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

  async #cleanupFailedStart(): Promise<void> {
    if (this.#conversation || this.#triggerRunner) {
      await this.stop();
    } else {
      await this.#mcpBridge?.stop();
      this.#mcpBridge = undefined;
      this.#strategy = undefined;
    }
  }

  async [Symbol.asyncDispose](): Promise<void> {
    await this.dispose();
  }

  async chat(prompt: Content): Promise<ChatResponse> {
    return await this.conversation.chat(prompt);
  }

  get isStarted(): boolean {
    return this.#conversation !== undefined;
  }

  get is_started(): boolean {
    return this.isStarted;
  }

  get conversation(): Conversation {
    if (!this.#conversation) {
      throw new Error("Agent session not started. Use 'await Agent.start(...)'.");
    }
    return this.#conversation;
  }

  get conversationId(): string | undefined {
    return this.#conversation?.conversationId || undefined;
  }

  get conversation_id(): string | undefined {
    return this.conversationId;
  }
}
