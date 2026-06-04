import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { CapabilitiesConfig, GeminiConfig, SystemInstructionSection, TemplatedSystemInstructions, } from "../../types.js";
import { AgentConfig, cloneCapabilitiesConfig, cloneMcpServerConfig, cloneSystemInstructions, } from "../connection.js";
import { LocalConnectionStrategy } from "./local-connection.js";
import * as policy from "../../hooks/policy.js";
const DEFAULT_APP_DATA_DIR = resolve(process.env.HOME ?? process.cwd(), ".gemini", "antigravity");
export class LocalAgentConfig extends AgentConfig {
    geminiConfig;
    model;
    apiKey;
    vertex;
    project;
    location;
    runtimePath;
    constructor(init = {}) {
        const appDataDir = init.appDataDir ?? init.app_data_dir;
        if (appDataDir !== undefined && !isAbsolute(appDataDir)) {
            throw new Error(`appDataDir must be an absolute path, got '${appDataDir}'`);
        }
        const workspaces = init.workspaces ?? [process.cwd()];
        const basePolicies = init.policies ?? policy.confirmRunCommand();
        const workspacePolicies = workspaces.length
            ? policy.workspaceOnly([...(workspaces ?? []), appDataDir ?? DEFAULT_APP_DATA_DIR])
            : [];
        super({
            ...init,
            capabilities: init.capabilities ?? new CapabilitiesConfig(),
            policies: [...workspacePolicies, ...basePolicies],
            workspaces,
        });
        this.geminiConfig = new GeminiConfig(init.geminiConfig ?? init.gemini_config);
        this.model = init.model;
        this.apiKey = init.apiKey ?? init.api_key;
        this.vertex = init.vertex;
        this.project = init.project;
        this.location = init.location;
        this.runtimePath = init.runtimePath ?? init.runtime_path;
        this.#applyShorthandConfigs(init);
    }
    #applyShorthandConfigs(init) {
        const hasGeminiConfig = (init.geminiConfig ?? init.gemini_config) !== undefined;
        if (this.model !== undefined) {
            if (hasGeminiConfig && this.geminiConfig.models.defaultExplicit) {
                throw new Error("Cannot set both 'model' shorthand and 'geminiConfig.models.default'. Use one or the other.");
            }
            this.geminiConfig.models.default.name = this.model;
        }
        if (this.apiKey !== undefined) {
            if (hasGeminiConfig && this.geminiConfig.apiKey !== undefined) {
                throw new Error("Cannot set both 'apiKey' shorthand and 'geminiConfig.apiKey'. Use one or the other.");
            }
            this.geminiConfig.apiKey = this.apiKey;
        }
        if (this.vertex !== undefined) {
            this.geminiConfig.vertex = this.vertex;
        }
        if (this.project !== undefined) {
            this.geminiConfig.project = this.project;
        }
        if (this.location !== undefined) {
            this.geminiConfig.location = this.location;
        }
    }
    get gemini_config() {
        return this.geminiConfig;
    }
    set gemini_config(value) {
        this.geminiConfig = new GeminiConfig(value);
    }
    get api_key() {
        return this.apiKey;
    }
    set api_key(value) {
        this.apiKey = value;
        this.geminiConfig.apiKey = value;
    }
    get runtime_path() {
        return this.runtimePath;
    }
    set runtime_path(value) {
        this.runtimePath = value;
    }
    createStrategy(args) {
        const toolRunner = args.toolRunner ?? args.tool_runner;
        const hookRunner = args.hookRunner ?? args.hook_runner;
        const systemInstructions = typeof this.systemInstructions === "string"
            ? new TemplatedSystemInstructions({
                sections: [
                    new SystemInstructionSection({
                        content: this.systemInstructions,
                    }),
                ],
            })
            : this.systemInstructions;
        const saveDir = this.saveDir ?? mkdtempSync(join(tmpdir(), "antigravity_"));
        return new LocalConnectionStrategy({
            runtimePath: this.runtimePath,
            conversationId: this.conversationId,
            toolRunner: toolRunner,
            hookRunner: hookRunner,
            geminiConfig: this.geminiConfig,
            systemInstructions,
            capabilitiesConfig: this.capabilities,
            saveDir,
            workspaces: this.workspaces,
            appDataDir: this.appDataDir,
            skillsPaths: this.skillsPaths,
        });
    }
    clone() {
        const clone = Object.create(LocalAgentConfig.prototype);
        clone.systemInstructions = cloneSystemInstructions(this.systemInstructions);
        clone.capabilities = cloneCapabilitiesConfig(this.capabilities);
        clone.tools = [...this.tools];
        clone.policies = [...this.policies];
        clone.hooks = [...this.hooks];
        clone.triggers = [...this.triggers];
        clone.mcpServers = this.mcpServers.map(cloneMcpServerConfig);
        clone.workspaces = [...this.workspaces];
        clone.conversationId = this.conversationId;
        clone.saveDir = this.saveDir;
        clone.appDataDir = this.appDataDir;
        clone.responseSchema = this.responseSchema;
        clone.skillsPaths = [...this.skillsPaths];
        clone.geminiConfig = new GeminiConfig(this.geminiConfig);
        clone.model = this.model;
        clone.apiKey = this.apiKey;
        clone.vertex = this.vertex;
        clone.project = this.project;
        clone.location = this.location;
        clone.runtimePath = this.runtimePath;
        return clone;
    }
}
//# sourceMappingURL=local-agent-config.js.map