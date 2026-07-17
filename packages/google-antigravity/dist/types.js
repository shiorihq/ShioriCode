import { readFileSync } from "node:fs";
import { extname } from "node:path";
export const DEFAULT_MODEL = "gemini-3.5-flash";
export const DEFAULT_IMAGE_GENERATION_MODEL = "gemini-3.1-flash-image-preview";
export var ThinkingLevel;
(function (ThinkingLevel) {
    ThinkingLevel["MINIMAL"] = "minimal";
    ThinkingLevel["LOW"] = "low";
    ThinkingLevel["MEDIUM"] = "medium";
    ThinkingLevel["HIGH"] = "high";
})(ThinkingLevel || (ThinkingLevel = {}));
function validateThinkingLevel(value) {
    if (value === undefined) {
        return undefined;
    }
    if (Object.values(ThinkingLevel).includes(value)) {
        return value;
    }
    throw new Error(`Unsupported ThinkingLevel: '${value}'.`);
}
export class GenerationConfig {
    thinkingLevel;
    constructor(init = {}) {
        this.thinkingLevel = validateThinkingLevel(init.thinkingLevel ?? init.thinking_level);
    }
    get thinking_level() {
        return this.thinkingLevel;
    }
    set thinking_level(value) {
        this.thinkingLevel = validateThinkingLevel(value);
    }
    toJSON() {
        return {
            thinking_level: this.thinkingLevel,
        };
    }
}
export class ModelEntry {
    name;
    apiKey;
    generation;
    constructor(init) {
        if (typeof init === "string") {
            this.name = init;
            this.generation = new GenerationConfig();
            return;
        }
        if (init.name === undefined || init.name === null) {
            throw new Error("ModelEntry.name is required.");
        }
        this.name = init.name;
        this.apiKey = init.apiKey ?? init.api_key;
        this.generation = new GenerationConfig(init.generation);
    }
    get api_key() {
        return this.apiKey;
    }
    set api_key(value) {
        this.apiKey = value;
    }
    toJSON() {
        return {
            name: this.name,
            api_key: this.apiKey,
            generation: this.generation.toJSON(),
        };
    }
}
export class ModelConfig {
    #defaultExplicit;
    default;
    imageGeneration;
    constructor(init = {}) {
        const imageGeneration = init.imageGeneration ?? init.image_generation;
        this.#defaultExplicit =
            init instanceof ModelConfig ? init.defaultExplicit : init.default !== undefined;
        this.default =
            typeof init.default === "string"
                ? new ModelEntry(init.default)
                : init.default
                    ? new ModelEntry(init.default)
                    : new ModelEntry(DEFAULT_MODEL);
        this.imageGeneration =
            typeof imageGeneration === "string"
                ? new ModelEntry(imageGeneration)
                : imageGeneration
                    ? new ModelEntry(imageGeneration)
                    : new ModelEntry(DEFAULT_IMAGE_GENERATION_MODEL);
    }
    get defaultExplicit() {
        return this.#defaultExplicit;
    }
    get image_generation() {
        return this.imageGeneration;
    }
    set image_generation(value) {
        this.imageGeneration =
            typeof value === "string" ? new ModelEntry(value) : new ModelEntry(value);
    }
    toJSON() {
        return {
            default: this.default.toJSON(),
            image_generation: this.imageGeneration.toJSON(),
        };
    }
}
export class GeminiConfig {
    apiKey;
    vertex = false;
    project;
    location;
    models;
    constructor(init = {}) {
        this.apiKey = init.apiKey ?? init.api_key;
        this.vertex = init.vertex ?? false;
        this.project = init.project;
        this.location = init.location;
        this.models = new ModelConfig(init.models);
    }
    get api_key() {
        return this.apiKey;
    }
    set api_key(value) {
        this.apiKey = value;
    }
    toJSON() {
        return {
            api_key: this.apiKey,
            vertex: this.vertex,
            project: this.project,
            location: this.location,
            models: this.models.toJSON(),
        };
    }
}
export class SystemInstructionSection {
    content;
    title;
    constructor(init) {
        if (init.content === undefined || init.content === null) {
            throw new Error("SystemInstructionSection.content is required.");
        }
        this.content = init.content;
        this.title = init.title ?? "user_system_instructions";
    }
    toJSON() {
        return {
            content: this.content,
            title: this.title,
        };
    }
}
export class CustomSystemInstructions {
    text;
    constructor(init) {
        if (typeof init !== "string" && (init.text === undefined || init.text === null)) {
            throw new Error("CustomSystemInstructions.text is required.");
        }
        this.text = typeof init === "string" ? init : init.text;
    }
    toJSON() {
        return {
            text: this.text,
        };
    }
}
export class TemplatedSystemInstructions {
    identity;
    sections;
    constructor(init = {}) {
        if (init.sections !== undefined && !Array.isArray(init.sections)) {
            throw new Error("TemplatedSystemInstructions.sections must be an array.");
        }
        this.identity = init.identity;
        this.sections = (init.sections ?? []).map((section) => section instanceof SystemInstructionSection ? section : new SystemInstructionSection(section));
    }
    toJSON() {
        return {
            identity: this.identity,
            sections: this.sections.map((section) => section.toJSON()),
        };
    }
}
export var BuiltinTools;
(function (BuiltinTools) {
    BuiltinTools["LIST_DIR"] = "list_directory";
    BuiltinTools["SEARCH_DIR"] = "search_directory";
    BuiltinTools["FIND_FILE"] = "find_file";
    BuiltinTools["VIEW_FILE"] = "view_file";
    BuiltinTools["CREATE_FILE"] = "create_file";
    BuiltinTools["EDIT_FILE"] = "edit_file";
    BuiltinTools["RUN_COMMAND"] = "run_command";
    BuiltinTools["ASK_QUESTION"] = "ask_question";
    BuiltinTools["START_SUBAGENT"] = "start_subagent";
    BuiltinTools["GENERATE_IMAGE"] = "generate_image";
    BuiltinTools["FINISH"] = "finish";
})(BuiltinTools || (BuiltinTools = {}));
(function (BuiltinTools) {
    function readOnly() {
        return [
            BuiltinTools.LIST_DIR,
            BuiltinTools.SEARCH_DIR,
            BuiltinTools.FIND_FILE,
            BuiltinTools.VIEW_FILE,
            BuiltinTools.FINISH,
        ];
    }
    BuiltinTools.readOnly = readOnly;
    function read_only() {
        return readOnly();
    }
    BuiltinTools.read_only = read_only;
    function nondestructive() {
        return [
            BuiltinTools.LIST_DIR,
            BuiltinTools.SEARCH_DIR,
            BuiltinTools.FIND_FILE,
            BuiltinTools.VIEW_FILE,
            BuiltinTools.CREATE_FILE,
            BuiltinTools.EDIT_FILE,
            BuiltinTools.ASK_QUESTION,
            BuiltinTools.START_SUBAGENT,
            BuiltinTools.GENERATE_IMAGE,
            BuiltinTools.FINISH,
        ];
    }
    BuiltinTools.nondestructive = nondestructive;
    function allTools() {
        return Object.values(BuiltinTools).filter((value) => typeof value === "string");
    }
    BuiltinTools.allTools = allTools;
    function all_tools() {
        return allTools();
    }
    BuiltinTools.all_tools = all_tools;
    function fileTools() {
        return [BuiltinTools.VIEW_FILE, BuiltinTools.CREATE_FILE, BuiltinTools.EDIT_FILE];
    }
    BuiltinTools.fileTools = fileTools;
    function file_tools() {
        return fileTools();
    }
    BuiltinTools.file_tools = file_tools;
    function none() {
        return [];
    }
    BuiltinTools.none = none;
})(BuiltinTools || (BuiltinTools = {}));
export class CapabilitiesConfig {
    enableSubagents = true;
    enabledTools;
    disabledTools;
    compactionThreshold;
    imageModel = DEFAULT_IMAGE_GENERATION_MODEL;
    finishToolSchemaJson;
    constructor(init = {}) {
        const enabledTools = init.enabledTools ?? init.enabled_tools;
        const disabledTools = init.disabledTools ?? init.disabled_tools;
        if (enabledTools !== undefined && disabledTools !== undefined) {
            throw new Error("enabledTools and disabledTools should be mutually exclusive.");
        }
        this.enableSubagents = init.enableSubagents ?? init.enable_subagents ?? true;
        this.enabledTools = enabledTools;
        this.disabledTools = disabledTools;
        this.compactionThreshold = init.compactionThreshold ?? init.compaction_threshold;
        this.imageModel = init.imageModel ?? init.image_model ?? DEFAULT_IMAGE_GENERATION_MODEL;
        this.finishToolSchemaJson = init.finishToolSchemaJson ?? init.finish_tool_schema_json;
    }
    get enable_subagents() {
        return this.enableSubagents;
    }
    set enable_subagents(value) {
        this.enableSubagents = value;
    }
    get enabled_tools() {
        return this.enabledTools;
    }
    set enabled_tools(value) {
        this.enabledTools = value;
    }
    get disabled_tools() {
        return this.disabledTools;
    }
    set disabled_tools(value) {
        this.disabledTools = value;
    }
    get compaction_threshold() {
        return this.compactionThreshold;
    }
    set compaction_threshold(value) {
        this.compactionThreshold = value;
    }
    get image_model() {
        return this.imageModel;
    }
    set image_model(value) {
        this.imageModel = value;
    }
    get finish_tool_schema_json() {
        return this.finishToolSchemaJson;
    }
    set finish_tool_schema_json(value) {
        this.finishToolSchemaJson = value;
    }
    toJSON() {
        return {
            enable_subagents: this.enableSubagents,
            enabled_tools: this.enabledTools,
            disabled_tools: this.disabledTools,
            compaction_threshold: this.compactionThreshold,
            image_model: this.imageModel,
            finish_tool_schema_json: this.finishToolSchemaJson,
        };
    }
}
const MCP_NAME_RE = /^[a-zA-Z0-9_-]+$/;
export class BaseMcpServerConfig {
    name;
    enabledTools;
    disabledTools;
    constructor(init) {
        if (typeof init.name !== "string") {
            throw new Error("MCP server name is required.");
        }
        if (!MCP_NAME_RE.test(init.name)) {
            throw new Error("MCP server name must contain only letters, numbers, underscores, and hyphens.");
        }
        const enabledTools = init.enabledTools ?? init.enabled_tools;
        const disabledTools = init.disabledTools ?? init.disabled_tools;
        if (enabledTools !== undefined && disabledTools !== undefined) {
            throw new Error("enabledTools and disabledTools should be mutually exclusive.");
        }
        this.name = init.name;
        this.enabledTools = enabledTools;
        this.disabledTools = disabledTools;
    }
    get enabled_tools() {
        return this.enabledTools;
    }
    set enabled_tools(value) {
        this.enabledTools = value;
    }
    get disabled_tools() {
        return this.disabledTools;
    }
    set disabled_tools(value) {
        this.disabledTools = value;
    }
    toBaseJSON() {
        return {
            name: this.name,
            enabled_tools: this.enabledTools,
            disabled_tools: this.disabledTools,
        };
    }
}
export class McpStdioServer extends BaseMcpServerConfig {
    type = "stdio";
    command;
    args;
    env;
    constructor(init) {
        super(init);
        if (typeof init.command !== "string") {
            throw new Error("McpStdioServer.command is required.");
        }
        this.command = init.command;
        this.args = init.args ?? [];
        this.env = init.env ? { ...init.env } : undefined;
    }
    toJSON() {
        return {
            ...this.toBaseJSON(),
            type: this.type,
            command: this.command,
            args: this.args,
            env: this.env,
        };
    }
}
export class McpSseServer extends BaseMcpServerConfig {
    type = "sse";
    url;
    headers;
    constructor(init) {
        super(init);
        if (typeof init.url !== "string") {
            throw new Error("McpSseServer.url is required.");
        }
        this.url = init.url;
        this.headers = init.headers;
    }
    toJSON() {
        return {
            ...this.toBaseJSON(),
            type: this.type,
            url: this.url,
            headers: this.headers,
        };
    }
}
export class McpStreamableHttpServer extends BaseMcpServerConfig {
    type = "http";
    url;
    headers;
    timeout = 30;
    sseReadTimeout = 300;
    terminateOnClose = true;
    constructor(init) {
        super(init);
        if (typeof init.url !== "string") {
            throw new Error("McpStreamableHttpServer.url is required.");
        }
        this.url = init.url;
        this.headers = init.headers;
        this.timeout = init.timeout ?? 30;
        this.sseReadTimeout = init.sseReadTimeout ?? init.sse_read_timeout ?? 300;
        this.terminateOnClose = init.terminateOnClose ?? init.terminate_on_close ?? true;
    }
    get sse_read_timeout() {
        return this.sseReadTimeout;
    }
    set sse_read_timeout(value) {
        this.sseReadTimeout = value;
    }
    get terminate_on_close() {
        return this.terminateOnClose;
    }
    set terminate_on_close(value) {
        this.terminateOnClose = value;
    }
    toJSON() {
        return {
            ...this.toBaseJSON(),
            type: this.type,
            url: this.url,
            headers: this.headers,
            timeout: this.timeout,
            sse_read_timeout: this.sseReadTimeout,
            terminate_on_close: this.terminateOnClose,
        };
    }
}
export class ToolCall {
    name;
    args;
    id;
    canonicalPath;
    constructor(init) {
        if (init.name === undefined || init.name === null) {
            throw new Error("ToolCall.name is required.");
        }
        this.name = init.name;
        if (init.args !== undefined &&
            (init.args === null || typeof init.args !== "object" || Array.isArray(init.args))) {
            throw new Error("ToolCall.args must be an object.");
        }
        this.args = init.args ?? {};
        this.id = init.id;
        this.canonicalPath = init.canonicalPath ?? init.canonical_path;
    }
    get canonical_path() {
        return this.canonicalPath;
    }
    set canonical_path(value) {
        this.canonicalPath = value;
    }
    toJSON() {
        return {
            name: this.name,
            args: this.args,
            id: this.id,
            canonical_path: this.canonicalPath,
        };
    }
}
export class ToolResult {
    name;
    id;
    result;
    error;
    exception;
    constructor(init) {
        if (init.name === undefined || init.name === null) {
            throw new Error("ToolResult.name is required.");
        }
        this.name = init.name;
        this.id = init.id;
        this.result = init.result;
        this.error = init.error;
        this.exception = init.exception;
    }
    toJSON() {
        return {
            name: this.name,
            id: this.id,
            result: this.result,
            error: this.error,
        };
    }
}
export class UsageMetadata {
    promptTokenCount;
    cachedContentTokenCount;
    candidatesTokenCount;
    thoughtsTokenCount;
    totalTokenCount;
    constructor(init = {}) {
        this.promptTokenCount = init.promptTokenCount ?? init.prompt_token_count;
        this.cachedContentTokenCount = init.cachedContentTokenCount ?? init.cached_content_token_count;
        this.candidatesTokenCount = init.candidatesTokenCount ?? init.candidates_token_count;
        this.thoughtsTokenCount = init.thoughtsTokenCount ?? init.thoughts_token_count;
        this.totalTokenCount = init.totalTokenCount ?? init.total_token_count;
    }
    get prompt_token_count() {
        return this.promptTokenCount;
    }
    set prompt_token_count(value) {
        this.promptTokenCount = value;
    }
    get cached_content_token_count() {
        return this.cachedContentTokenCount;
    }
    set cached_content_token_count(value) {
        this.cachedContentTokenCount = value;
    }
    get candidates_token_count() {
        return this.candidatesTokenCount;
    }
    set candidates_token_count(value) {
        this.candidatesTokenCount = value;
    }
    get thoughts_token_count() {
        return this.thoughtsTokenCount;
    }
    set thoughts_token_count(value) {
        this.thoughtsTokenCount = value;
    }
    get total_token_count() {
        return this.totalTokenCount;
    }
    set total_token_count(value) {
        this.totalTokenCount = value;
    }
    toJSON() {
        return {
            prompt_token_count: this.promptTokenCount,
            cached_content_token_count: this.cachedContentTokenCount,
            candidates_token_count: this.candidatesTokenCount,
            thoughts_token_count: this.thoughtsTokenCount,
            total_token_count: this.totalTokenCount,
        };
    }
}
export var StepType;
(function (StepType) {
    StepType["TEXT_RESPONSE"] = "TEXT_RESPONSE";
    StepType["TOOL_CALL"] = "TOOL_CALL";
    StepType["SYSTEM_MESSAGE"] = "SYSTEM_MESSAGE";
    StepType["COMPACTION"] = "COMPACTION";
    StepType["FINISH"] = "FINISH";
    StepType["UNKNOWN"] = "UNKNOWN";
})(StepType || (StepType = {}));
export var StepSource;
(function (StepSource) {
    StepSource["SYSTEM"] = "SYSTEM";
    StepSource["USER"] = "USER";
    StepSource["MODEL"] = "MODEL";
    StepSource["UNKNOWN"] = "UNKNOWN";
})(StepSource || (StepSource = {}));
export var StepTarget;
(function (StepTarget) {
    StepTarget["USER"] = "TARGET_USER";
    StepTarget["ENVIRONMENT"] = "TARGET_ENVIRONMENT";
    StepTarget["UNSPECIFIED"] = "TARGET_UNSPECIFIED";
    StepTarget["UNKNOWN"] = "UNKNOWN";
})(StepTarget || (StepTarget = {}));
export var StepStatus;
(function (StepStatus) {
    StepStatus["ACTIVE"] = "ACTIVE";
    StepStatus["DONE"] = "DONE";
    StepStatus["WAITING_FOR_USER"] = "WAITING_FOR_USER";
    StepStatus["ERROR"] = "ERROR";
    StepStatus["CANCELED"] = "CANCELED";
    StepStatus["TERMINAL_ERROR"] = "TERMINAL_ERROR";
    StepStatus["UNKNOWN"] = "UNKNOWN";
})(StepStatus || (StepStatus = {}));
export class Step {
    id = "";
    stepIndex = 0;
    type = StepType.UNKNOWN;
    source = StepSource.UNKNOWN;
    target = StepTarget.UNKNOWN;
    status = StepStatus.UNKNOWN;
    content = "";
    contentDelta = "";
    thinking = "";
    thinkingDelta = "";
    toolCalls = [];
    error = "";
    isCompleteResponse;
    structuredOutput;
    usageMetadata;
    constructor(init = {}) {
        Object.assign(this, init);
        this.stepIndex = init.stepIndex ?? init.step_index ?? this.stepIndex;
        this.contentDelta = init.contentDelta ?? init.content_delta ?? this.contentDelta;
        this.thinkingDelta = init.thinkingDelta ?? init.thinking_delta ?? this.thinkingDelta;
        this.isCompleteResponse =
            init.isCompleteResponse ?? init.is_complete_response ?? this.isCompleteResponse;
        this.structuredOutput =
            init.structuredOutput ?? init.structured_output ?? this.structuredOutput;
        this.toolCalls = (init.toolCalls ?? init.tool_calls ?? []).map((call) => call instanceof ToolCall
            ? call
            : new ToolCall(call));
        const usageMetadata = init.usageMetadata ?? init.usage_metadata;
        this.usageMetadata = usageMetadata ? new UsageMetadata(usageMetadata) : undefined;
    }
    get step_index() {
        return this.stepIndex;
    }
    set step_index(value) {
        this.stepIndex = value;
    }
    get content_delta() {
        return this.contentDelta;
    }
    set content_delta(value) {
        this.contentDelta = value;
    }
    get thinking_delta() {
        return this.thinkingDelta;
    }
    set thinking_delta(value) {
        this.thinkingDelta = value;
    }
    get tool_calls() {
        return this.toolCalls;
    }
    set tool_calls(value) {
        this.toolCalls = value.map((call) => (call instanceof ToolCall ? call : new ToolCall(call)));
    }
    get is_complete_response() {
        return this.isCompleteResponse;
    }
    set is_complete_response(value) {
        this.isCompleteResponse = value;
    }
    get structured_output() {
        return this.structuredOutput;
    }
    set structured_output(value) {
        this.structuredOutput = value;
    }
    get usage_metadata() {
        return this.usageMetadata;
    }
    set usage_metadata(value) {
        this.usageMetadata =
            value === undefined
                ? undefined
                : value instanceof UsageMetadata
                    ? value
                    : new UsageMetadata(value);
    }
    toJSON() {
        const json = {
            id: this.id,
            step_index: this.stepIndex,
            type: this.type,
            source: this.source,
            target: this.target,
            status: this.status,
            content: this.content,
            content_delta: this.contentDelta,
            thinking: this.thinking,
            thinking_delta: this.thinkingDelta,
            tool_calls: this.toolCalls.map((call) => call.toJSON()),
            error: this.error,
            is_complete_response: this.isCompleteResponse,
            structured_output: this.structuredOutput,
            usage_metadata: this.usageMetadata?.toJSON(),
        };
        for (const [key, value] of Object.entries(this)) {
            if (!STEP_SERIALIZED_FIELD_NAMES.has(key)) {
                json[key] = value;
            }
        }
        return json;
    }
}
const STEP_SERIALIZED_FIELD_NAMES = new Set([
    "id",
    "stepIndex",
    "step_index",
    "type",
    "source",
    "target",
    "status",
    "content",
    "contentDelta",
    "content_delta",
    "thinking",
    "thinkingDelta",
    "thinking_delta",
    "toolCalls",
    "tool_calls",
    "error",
    "isCompleteResponse",
    "is_complete_response",
    "structuredOutput",
    "structured_output",
    "usageMetadata",
    "usage_metadata",
]);
export class HookResult {
    allow = true;
    message = "";
    constructor(init = {}) {
        this.allow = init.allow ?? true;
        this.message = init.message ?? "";
    }
}
export class QuestionResponse {
    selectedOptionIds;
    freeformResponse = "";
    skipped = false;
    constructor(init = {}) {
        this.selectedOptionIds = init.selectedOptionIds ?? init.selected_option_ids;
        this.freeformResponse = init.freeformResponse ?? init.freeform_response ?? "";
        this.skipped = init.skipped ?? false;
    }
    get selected_option_ids() {
        return this.selectedOptionIds;
    }
    set selected_option_ids(value) {
        this.selectedOptionIds = value;
    }
    get freeform_response() {
        return this.freeformResponse;
    }
    set freeform_response(value) {
        this.freeformResponse = value;
    }
    toJSON() {
        return {
            selected_option_ids: this.selectedOptionIds,
            freeform_response: this.freeformResponse,
            skipped: this.skipped,
        };
    }
}
export class QuestionHookResult {
    responses;
    cancelled = false;
    constructor(init) {
        if (!Array.isArray(init.responses)) {
            throw new Error("QuestionHookResult.responses is required.");
        }
        this.responses = init.responses.map((response) => response instanceof QuestionResponse ? response : new QuestionResponse(response));
        this.cancelled = init.cancelled ?? false;
    }
    toJSON() {
        return {
            responses: this.responses.map((response) => response.toJSON()),
            cancelled: this.cancelled,
        };
    }
}
export class AskQuestionOption {
    id;
    text;
    constructor(init) {
        if (init.id === undefined || init.id === null) {
            throw new Error("AskQuestionOption.id is required.");
        }
        if (init.text === undefined || init.text === null) {
            throw new Error("AskQuestionOption.text is required.");
        }
        this.id = init.id;
        this.text = init.text;
        Object.freeze(this);
    }
    toJSON() {
        return {
            id: this.id,
            text: this.text,
        };
    }
}
export class AskQuestionEntry {
    question;
    options;
    isMultiSelect;
    constructor(init) {
        if (init.question === undefined || init.question === null) {
            throw new Error("AskQuestionEntry.question is required.");
        }
        if (!Array.isArray(init.options)) {
            throw new Error("AskQuestionEntry.options is required.");
        }
        this.question = init.question;
        this.options = init.options.map((option) => option instanceof AskQuestionOption ? option : new AskQuestionOption(option));
        this.isMultiSelect = init.isMultiSelect ?? init.is_multi_select ?? false;
        Object.freeze(this);
    }
    get is_multi_select() {
        return this.isMultiSelect;
    }
    toJSON() {
        return {
            question: this.question,
            options: this.options.map((option) => option.toJSON()),
            is_multi_select: this.isMultiSelect,
        };
    }
}
export class AskQuestionInteractionSpec {
    questions;
    constructor(init) {
        if (!Array.isArray(init.questions)) {
            throw new Error("AskQuestionInteractionSpec.questions is required.");
        }
        this.questions = init.questions.map((question) => question instanceof AskQuestionEntry ? question : new AskQuestionEntry(question));
        Object.freeze(this);
    }
    toJSON() {
        return {
            questions: this.questions.map((question) => question.toJSON()),
        };
    }
}
export class AntigravityConnectionError extends Error {
    name = "AntigravityConnectionError";
}
export class AntigravityExecutionError extends Error {
    name = "AntigravityExecutionError";
}
export class AntigravityValidationError extends Error {
    name = "AntigravityValidationError";
    errors;
    constructor(message, errors = []) {
        super(message);
        this.errors = [...errors];
    }
    static fromPydantic(exc) {
        return new AntigravityValidationError(String(exc), extractValidationErrors(exc));
    }
    static from_pydantic = AntigravityValidationError.fromPydantic;
}
function extractValidationErrors(exc) {
    if (!exc || typeof exc !== "object") {
        return [];
    }
    const maybeErrors = exc.errors;
    const errors = typeof maybeErrors === "function" ? maybeErrors.call(exc) : maybeErrors;
    if (!Array.isArray(errors)) {
        return [];
    }
    return errors.filter((error) => error !== null && typeof error === "object" && !Array.isArray(error));
}
export var TriggerDelivery;
(function (TriggerDelivery) {
    TriggerDelivery["SEND_IMMEDIATELY"] = "send_immediately";
    TriggerDelivery["WAIT_IDLE"] = "wait_idle";
})(TriggerDelivery || (TriggerDelivery = {}));
export var FileChangeKind;
(function (FileChangeKind) {
    FileChangeKind["ADDED"] = "added";
    FileChangeKind["MODIFIED"] = "modified";
    FileChangeKind["DELETED"] = "deleted";
})(FileChangeKind || (FileChangeKind = {}));
export class FileChange {
    kind;
    path;
    constructor(init) {
        this.kind = init.kind;
        this.path = init.path;
        Object.freeze(this);
    }
    toJSON() {
        return {
            kind: this.kind,
            path: this.path,
        };
    }
}
export class StreamChunk {
    stepIndex;
    constructor(init) {
        const stepIndex = init.stepIndex ?? init.step_index;
        if (stepIndex === undefined || stepIndex === null) {
            throw new Error("StreamChunk.stepIndex is required.");
        }
        this.stepIndex = stepIndex;
    }
    get step_index() {
        return this.stepIndex;
    }
}
export class Thought extends StreamChunk {
    text;
    signature;
    constructor(init) {
        super(init);
        if (init.text === undefined || init.text === null) {
            throw new Error("Thought.text is required.");
        }
        this.text = init.text;
        this.signature = init.signature;
        Object.freeze(this);
    }
    toJSON() {
        return {
            step_index: this.stepIndex,
            text: this.text,
            signature: this.signature,
        };
    }
}
export class Text extends StreamChunk {
    text;
    constructor(init) {
        super(init);
        if (init.text === undefined || init.text === null) {
            throw new Error("Text.text is required.");
        }
        this.text = init.text;
        Object.freeze(this);
    }
    toJSON() {
        return {
            step_index: this.stepIndex,
            text: this.text,
        };
    }
}
export class ChatResponse {
    #source;
    #conversation;
    #bufferedChunks = [];
    #done = false;
    #streamError;
    #pulling;
    constructor(chunkStream, conversation) {
        this.#source =
            Symbol.asyncIterator in chunkStream ? chunkStream[Symbol.asyncIterator]() : chunkStream;
        this.#conversation = conversation;
    }
    get chunks() {
        const self = this;
        return {
            async *[Symbol.asyncIterator]() {
                let pos = 0;
                while (true) {
                    if (pos < self.#bufferedChunks.length) {
                        yield self.#bufferedChunks[pos];
                        pos += 1;
                        continue;
                    }
                    if (self.#done) {
                        if (self.#streamError !== undefined) {
                            throw self.#streamError;
                        }
                        return;
                    }
                    await self.#pullOnce();
                }
            },
        };
    }
    async #pullOnce() {
        if (this.#pulling) {
            await this.#pulling;
            return;
        }
        this.#pulling = (async () => {
            try {
                const next = await this.#source.next();
                if (next.done) {
                    this.#done = true;
                }
                else {
                    this.#bufferedChunks.push(next.value);
                }
            }
            catch (error) {
                this.#done = true;
                this.#streamError = error;
                throw error;
            }
            finally {
                this.#pulling = undefined;
            }
        })();
        await this.#pulling;
    }
    async *[Symbol.asyncIterator]() {
        for await (const chunk of this.chunks) {
            if (chunk instanceof Text) {
                yield chunk.text;
            }
        }
    }
    get thoughts() {
        const self = this;
        return {
            async *[Symbol.asyncIterator]() {
                for await (const chunk of self.chunks) {
                    if (chunk instanceof Thought) {
                        yield chunk.text;
                    }
                }
            },
        };
    }
    get toolCalls() {
        const self = this;
        return {
            async *[Symbol.asyncIterator]() {
                for await (const chunk of self.chunks) {
                    if (chunk instanceof ToolCall) {
                        yield chunk;
                    }
                }
            },
        };
    }
    get tool_calls() {
        return this.toolCalls;
    }
    async resolve() {
        const chunks = [];
        for await (const chunk of this.chunks) {
            chunks.push(chunk);
        }
        return chunks;
    }
    async text() {
        const chunks = await this.resolve();
        return chunks
            .filter((chunk) => chunk instanceof Text)
            .map((chunk) => chunk.text)
            .join("");
    }
    async structuredOutput() {
        if (!this.#done) {
            await this.resolve();
        }
        if (this.#conversation.getLastStructuredOutput) {
            return this.#conversation.getLastStructuredOutput();
        }
        return this.#conversation.get_last_structured_output?.();
    }
    structured_output() {
        return this.structuredOutput();
    }
    get usageMetadata() {
        return this.#conversation.lastTurnUsage ?? this.#conversation.last_turn_usage;
    }
    get usage_metadata() {
        return this.usageMetadata;
    }
}
export const SUPPORTED_IMAGE_MIMES = new Set([
    "image/bmp",
    "image/jpeg",
    "image/png",
    "image/webp",
]);
export const SUPPORTED_DOCUMENT_MIMES = new Set([
    "application/pdf",
    "application/json",
    "text/css",
    "text/csv",
    "text/html",
    "text/javascript",
    "text/plain",
    "text/rtf",
    "text/xml",
]);
export const SUPPORTED_AUDIO_MIMES = new Set([
    "audio/wav",
    "audio/mp3",
    "audio/aac",
    "audio/ogg",
    "audio/flac",
    "audio/opus",
    "audio/mpeg",
    "audio/m4a",
    "audio/l16",
]);
export const SUPPORTED_VIDEO_MIMES = new Set([
    "video/3gpp",
    "video/avi",
    "video/mp4",
    "video/mpeg",
    "video/mpg",
    "video/quicktime",
    "video/webm",
    "video/wmv",
    "video/x-flv",
]);
const MIME_BY_EXTENSION = new Map([
    [".bmp", "image/bmp"],
    [".jpg", "image/jpeg"],
    [".jpeg", "image/jpeg"],
    [".png", "image/png"],
    [".webp", "image/webp"],
    [".pdf", "application/pdf"],
    [".json", "application/json"],
    [".css", "text/css"],
    [".csv", "text/csv"],
    [".html", "text/html"],
    [".htm", "text/html"],
    [".js", "text/javascript"],
    [".mjs", "text/javascript"],
    [".txt", "text/plain"],
    [".rtf", "text/rtf"],
    [".xml", "text/xml"],
    [".wav", "audio/wav"],
    [".mp3", "audio/mpeg"],
    [".aac", "audio/aac"],
    [".ogg", "audio/ogg"],
    [".flac", "audio/flac"],
    [".opus", "audio/opus"],
    [".m4a", "audio/m4a"],
    [".3gp", "video/3gpp"],
    [".avi", "video/avi"],
    [".mp4", "video/mp4"],
    [".mpeg", "video/mpeg"],
    [".mpg", "video/mpg"],
    [".mov", "video/quicktime"],
    [".webm", "video/webm"],
    [".wmv", "video/wmv"],
    [".flv", "video/x-flv"],
]);
function inferMime(path) {
    return MIME_BY_EXTENSION.get(extname(path).toLowerCase());
}
function readFileSafely(path) {
    try {
        return readFileSync(path);
    }
    catch (error) {
        const code = error && typeof error === "object" && "code" in error
            ? String(error.code)
            : "";
        if (code === "ENOENT") {
            throw new Error(`File not found at path: '${path}'`);
        }
        if (code === "EISDIR") {
            throw new Error(`Path is a directory, not a file: '${path}'`);
        }
        if (code === "EACCES" || code === "EPERM") {
            throw new Error(`Permission denied when reading path: '${path}'`);
        }
        throw new Error(`Failed to read file at path '${path}': ${String(error)}`);
    }
}
class BaseMedia {
    #data;
    mimeType;
    description;
    constructor(init) {
        this.#data = normalizeMediaData(init.data);
        Object.defineProperty(this, "data", {
            enumerable: true,
            configurable: false,
            get: () => new Uint8Array(this.#data),
        });
        this.mimeType = init.mimeType ?? init.mime_type ?? "";
        this.description = init.description;
        this.validateMimeType();
        Object.freeze(this);
    }
    get data() {
        return new Uint8Array(this.#data);
    }
    get mime_type() {
        return this.mimeType;
    }
    validateMimeType() {
        if (!this.supportedMimes().has(this.mimeType)) {
            throw new Error(`Unsupported ${this.constructor.name} MIME type: '${this.mimeType}'`);
        }
    }
}
function normalizeMediaData(data) {
    if (typeof data === "string") {
        return new TextEncoder().encode(data);
    }
    if (data instanceof ArrayBuffer) {
        return new Uint8Array(new Uint8Array(data));
    }
    return new Uint8Array(data);
}
export class Image extends BaseMedia {
    constructor(init) {
        super(init);
    }
    supportedMimes() {
        return SUPPORTED_IMAGE_MIMES;
    }
    static fromFile(path, description) {
        return new Image({
            data: readFileSafely(path),
            mimeType: inferMime(path) ?? "",
            description,
        });
    }
    static from_file(path, description) {
        return Image.fromFile(path, description);
    }
}
export class Document extends BaseMedia {
    constructor(init) {
        super(init);
    }
    supportedMimes() {
        return SUPPORTED_DOCUMENT_MIMES;
    }
    static fromFile(path, description) {
        return new Document({
            data: readFileSafely(path),
            mimeType: inferMime(path) ?? "",
            description,
        });
    }
    static from_file(path, description) {
        return Document.fromFile(path, description);
    }
}
export class Audio extends BaseMedia {
    constructor(init) {
        super(init);
    }
    supportedMimes() {
        return SUPPORTED_AUDIO_MIMES;
    }
    static fromFile(path, description) {
        return new Audio({
            data: readFileSafely(path),
            mimeType: inferMime(path) ?? "",
            description,
        });
    }
    static from_file(path, description) {
        return Audio.fromFile(path, description);
    }
}
export class Video extends BaseMedia {
    constructor(init) {
        super(init);
    }
    supportedMimes() {
        return SUPPORTED_VIDEO_MIMES;
    }
    static fromFile(path, description) {
        return new Video({
            data: readFileSafely(path),
            mimeType: inferMime(path) ?? "",
            description,
        });
    }
    static from_file(path, description) {
        return Video.fromFile(path, description);
    }
}
export function fromFile(path, description) {
    const data = readFileSafely(path);
    const mimeType = inferMime(path);
    if (!mimeType) {
        throw new Error(`Could not infer a valid MIME type for extension: '${extname(path)}'`);
    }
    if (SUPPORTED_IMAGE_MIMES.has(mimeType)) {
        return new Image({ data, mimeType, description });
    }
    if (SUPPORTED_DOCUMENT_MIMES.has(mimeType)) {
        return new Document({ data, mimeType, description });
    }
    if (SUPPORTED_AUDIO_MIMES.has(mimeType)) {
        return new Audio({ data, mimeType, description });
    }
    if (SUPPORTED_VIDEO_MIMES.has(mimeType)) {
        return new Video({ data, mimeType, description });
    }
    throw new Error(`Unsupported MIME type: '${mimeType}'. Supported file formats in the SDK are: ${[
        ...SUPPORTED_IMAGE_MIMES,
        ...SUPPORTED_DOCUMENT_MIMES,
        ...SUPPORTED_AUDIO_MIMES,
        ...SUPPORTED_VIDEO_MIMES,
    ]
        .sort()
        .join(", ")}`);
}
export const from_file = fromFile;
//# sourceMappingURL=types.js.map