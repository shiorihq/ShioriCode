export declare const DEFAULT_MODEL = "gemini-3.5-flash";
export declare const DEFAULT_IMAGE_GENERATION_MODEL = "gemini-3.1-flash-image-preview";
export declare enum ThinkingLevel {
    MINIMAL = "minimal",
    LOW = "low",
    MEDIUM = "medium",
    HIGH = "high"
}
export type GenerationConfigInit = {
    thinkingLevel?: ThinkingLevel | string;
    thinking_level?: ThinkingLevel | string;
};
export type ModelEntryInit = {
    name: string;
    apiKey?: string;
    api_key?: string;
    generation?: GenerationConfig | GenerationConfigInit;
};
export type ModelConfigInit = {
    default?: string | ModelEntry | ModelEntryInit;
    imageGeneration?: string | ModelEntry | ModelEntryInit;
    image_generation?: string | ModelEntry | ModelEntryInit;
};
export type GeminiConfigInit = {
    apiKey?: string;
    api_key?: string;
    vertex?: boolean;
    project?: string;
    location?: string;
    models?: ModelConfig | ModelConfigInit;
};
export declare class GenerationConfig {
    thinkingLevel?: ThinkingLevel;
    constructor(init?: GenerationConfigInit);
    get thinking_level(): ThinkingLevel | undefined;
    set thinking_level(value: ThinkingLevel | string | undefined);
    toJSON(): {
        thinking_level?: ThinkingLevel;
    };
}
export declare class ModelEntry {
    name: string;
    apiKey?: string;
    generation: GenerationConfig;
    constructor(init: string | ModelEntryInit);
    get api_key(): string | undefined;
    set api_key(value: string | undefined);
    toJSON(): {
        name: string;
        api_key?: string;
        generation: ReturnType<GenerationConfig["toJSON"]>;
    };
}
export declare class ModelConfig {
    #private;
    default: ModelEntry;
    imageGeneration: ModelEntry;
    constructor(init?: ModelConfigInit);
    get defaultExplicit(): boolean;
    get image_generation(): ModelEntry;
    set image_generation(value: string | ModelEntry | ModelEntryInit);
    toJSON(): {
        default: ReturnType<ModelEntry["toJSON"]>;
        image_generation: ReturnType<ModelEntry["toJSON"]>;
    };
}
export declare class GeminiConfig {
    apiKey?: string;
    vertex: boolean;
    project?: string;
    location?: string;
    models: ModelConfig;
    constructor(init?: GeminiConfigInit);
    get api_key(): string | undefined;
    set api_key(value: string | undefined);
    toJSON(): {
        api_key?: string;
        vertex: boolean;
        project?: string;
        location?: string;
        models: ReturnType<ModelConfig["toJSON"]>;
    };
}
export declare class SystemInstructionSection {
    content: string;
    title: string;
    constructor(init: {
        content: string;
        title?: string;
    });
    toJSON(): {
        content: string;
        title: string;
    };
}
export declare class CustomSystemInstructions {
    text: string;
    constructor(init: {
        text: string;
    } | string);
    toJSON(): {
        text: string;
    };
}
export declare class TemplatedSystemInstructions {
    identity?: string;
    sections: SystemInstructionSection[];
    constructor(init?: {
        identity?: string;
        sections?: Array<SystemInstructionSection | {
            content: string;
            title?: string;
        }>;
    });
    toJSON(): {
        identity?: string;
        sections: Array<ReturnType<SystemInstructionSection["toJSON"]>>;
    };
}
export type SystemInstructions = CustomSystemInstructions | TemplatedSystemInstructions;
export declare enum BuiltinTools {
    LIST_DIR = "list_directory",
    SEARCH_DIR = "search_directory",
    FIND_FILE = "find_file",
    VIEW_FILE = "view_file",
    CREATE_FILE = "create_file",
    EDIT_FILE = "edit_file",
    RUN_COMMAND = "run_command",
    ASK_QUESTION = "ask_question",
    START_SUBAGENT = "start_subagent",
    GENERATE_IMAGE = "generate_image",
    FINISH = "finish"
}
export declare namespace BuiltinTools {
    function readOnly(): BuiltinTools[];
    function read_only(): BuiltinTools[];
    function nondestructive(): BuiltinTools[];
    function allTools(): BuiltinTools[];
    function all_tools(): BuiltinTools[];
    function fileTools(): BuiltinTools[];
    function file_tools(): BuiltinTools[];
    function none(): BuiltinTools[];
}
export declare class CapabilitiesConfig {
    enableSubagents: boolean;
    enabledTools?: Array<BuiltinTools | string>;
    disabledTools?: Array<BuiltinTools | string>;
    compactionThreshold?: number;
    imageModel: string;
    finishToolSchemaJson?: string;
    constructor(init?: {
        enableSubagents?: boolean;
        enable_subagents?: boolean;
        enabledTools?: Array<BuiltinTools | string>;
        enabled_tools?: Array<BuiltinTools | string>;
        disabledTools?: Array<BuiltinTools | string>;
        disabled_tools?: Array<BuiltinTools | string>;
        compactionThreshold?: number;
        compaction_threshold?: number;
        imageModel?: string;
        image_model?: string;
        finishToolSchemaJson?: string;
        finish_tool_schema_json?: string;
    });
    get enable_subagents(): boolean;
    set enable_subagents(value: boolean);
    get enabled_tools(): Array<BuiltinTools | string> | undefined;
    set enabled_tools(value: Array<BuiltinTools | string> | undefined);
    get disabled_tools(): Array<BuiltinTools | string> | undefined;
    set disabled_tools(value: Array<BuiltinTools | string> | undefined);
    get compaction_threshold(): number | undefined;
    set compaction_threshold(value: number | undefined);
    get image_model(): string;
    set image_model(value: string);
    get finish_tool_schema_json(): string | undefined;
    set finish_tool_schema_json(value: string | undefined);
    toJSON(): {
        enable_subagents: boolean;
        enabled_tools?: Array<BuiltinTools | string>;
        disabled_tools?: Array<BuiltinTools | string>;
        compaction_threshold?: number;
        image_model: string;
        finish_tool_schema_json?: string;
    };
}
type McpToolFilters = {
    enabledTools?: string[];
    enabled_tools?: string[];
    disabledTools?: string[];
    disabled_tools?: string[];
};
export declare abstract class BaseMcpServerConfig {
    name: string;
    enabledTools?: string[];
    disabledTools?: string[];
    protected constructor(init: {
        name: string;
    } & McpToolFilters);
    get enabled_tools(): string[] | undefined;
    set enabled_tools(value: string[] | undefined);
    get disabled_tools(): string[] | undefined;
    set disabled_tools(value: string[] | undefined);
    protected toBaseJSON(): {
        name: string;
        enabled_tools?: string[];
        disabled_tools?: string[];
    };
}
export declare class McpStdioServer extends BaseMcpServerConfig {
    readonly type = "stdio";
    command: string;
    args: string[];
    constructor(init: {
        name: string;
        command: string;
        args?: string[];
    } & McpToolFilters);
    toJSON(): ReturnType<BaseMcpServerConfig["toBaseJSON"]> & {
        type: "stdio";
        command: string;
        args: string[];
    };
}
export declare class McpSseServer extends BaseMcpServerConfig {
    readonly type = "sse";
    url: string;
    headers?: Record<string, string>;
    constructor(init: {
        name: string;
        url: string;
        headers?: Record<string, string>;
    } & McpToolFilters);
    toJSON(): ReturnType<BaseMcpServerConfig["toBaseJSON"]> & {
        type: "sse";
        url: string;
        headers?: Record<string, string>;
    };
}
export declare class McpStreamableHttpServer extends BaseMcpServerConfig {
    readonly type = "http";
    url: string;
    headers?: Record<string, string>;
    timeout: number;
    sseReadTimeout: number;
    terminateOnClose: boolean;
    constructor(init: {
        name: string;
        url: string;
        headers?: Record<string, string>;
        timeout?: number;
        sseReadTimeout?: number;
        sse_read_timeout?: number;
        terminateOnClose?: boolean;
        terminate_on_close?: boolean;
    } & McpToolFilters);
    get sse_read_timeout(): number;
    set sse_read_timeout(value: number);
    get terminate_on_close(): boolean;
    set terminate_on_close(value: boolean);
    toJSON(): ReturnType<BaseMcpServerConfig["toBaseJSON"]> & {
        type: "http";
        url: string;
        headers?: Record<string, string>;
        timeout: number;
        sse_read_timeout: number;
        terminate_on_close: boolean;
    };
}
export type McpServerConfig = McpStdioServer | McpSseServer | McpStreamableHttpServer;
export declare class ToolCall {
    name: BuiltinTools | string;
    args: Record<string, unknown>;
    id?: string;
    canonicalPath?: string;
    constructor(init: {
        name: BuiltinTools | string;
        args?: Record<string, unknown>;
        id?: string;
        canonicalPath?: string;
        canonical_path?: string;
    });
    get canonical_path(): string | undefined;
    set canonical_path(value: string | undefined);
    toJSON(): {
        name: BuiltinTools | string;
        args: Record<string, unknown>;
        id?: string;
        canonical_path?: string;
    };
}
export declare class ToolResult {
    name: BuiltinTools | string;
    id?: string;
    result?: unknown;
    error?: string;
    exception?: unknown;
    constructor(init: {
        name: BuiltinTools | string;
        id?: string;
        result?: unknown;
        error?: string;
        exception?: unknown;
    });
    toJSON(): {
        name: BuiltinTools | string;
        id?: string;
        result?: unknown;
        error?: string;
    };
}
export type TypeScriptTool = (...args: any[]) => unknown | Promise<unknown>;
export type PythonTool = TypeScriptTool;
export declare class UsageMetadata {
    promptTokenCount?: number;
    cachedContentTokenCount?: number;
    candidatesTokenCount?: number;
    thoughtsTokenCount?: number;
    totalTokenCount?: number;
    constructor(init?: Partial<UsageMetadata> & {
        prompt_token_count?: number;
        cached_content_token_count?: number;
        candidates_token_count?: number;
        thoughts_token_count?: number;
        total_token_count?: number;
    });
    get prompt_token_count(): number | undefined;
    set prompt_token_count(value: number | undefined);
    get cached_content_token_count(): number | undefined;
    set cached_content_token_count(value: number | undefined);
    get candidates_token_count(): number | undefined;
    set candidates_token_count(value: number | undefined);
    get thoughts_token_count(): number | undefined;
    set thoughts_token_count(value: number | undefined);
    get total_token_count(): number | undefined;
    set total_token_count(value: number | undefined);
    toJSON(): {
        prompt_token_count?: number;
        cached_content_token_count?: number;
        candidates_token_count?: number;
        thoughts_token_count?: number;
        total_token_count?: number;
    };
}
export declare enum StepType {
    TEXT_RESPONSE = "TEXT_RESPONSE",
    TOOL_CALL = "TOOL_CALL",
    SYSTEM_MESSAGE = "SYSTEM_MESSAGE",
    COMPACTION = "COMPACTION",
    FINISH = "FINISH",
    UNKNOWN = "UNKNOWN"
}
export declare enum StepSource {
    SYSTEM = "SYSTEM",
    USER = "USER",
    MODEL = "MODEL",
    UNKNOWN = "UNKNOWN"
}
export declare enum StepTarget {
    USER = "TARGET_USER",
    ENVIRONMENT = "TARGET_ENVIRONMENT",
    UNSPECIFIED = "TARGET_UNSPECIFIED",
    UNKNOWN = "UNKNOWN"
}
export declare enum StepStatus {
    ACTIVE = "ACTIVE",
    DONE = "DONE",
    WAITING_FOR_USER = "WAITING_FOR_USER",
    ERROR = "ERROR",
    CANCELED = "CANCELED",
    TERMINAL_ERROR = "TERMINAL_ERROR",
    UNKNOWN = "UNKNOWN"
}
export declare class Step {
    id: string;
    stepIndex: number;
    type: StepType;
    source: StepSource;
    target: StepTarget;
    status: StepStatus;
    content: string;
    contentDelta: string;
    thinking: string;
    thinkingDelta: string;
    toolCalls: ToolCall[];
    error: string;
    isCompleteResponse?: boolean;
    structuredOutput?: unknown;
    usageMetadata?: UsageMetadata;
    [key: string]: unknown;
    constructor(init?: Partial<Step> & {
        step_index?: number;
        content_delta?: string;
        thinking_delta?: string;
        tool_calls?: Array<ToolCall | ConstructorParameters<typeof ToolCall>[0]>;
        is_complete_response?: boolean;
        structured_output?: unknown;
        usage_metadata?: ConstructorParameters<typeof UsageMetadata>[0];
    });
    get step_index(): number;
    set step_index(value: number);
    get content_delta(): string;
    set content_delta(value: string);
    get thinking_delta(): string;
    set thinking_delta(value: string);
    get tool_calls(): ToolCall[];
    set tool_calls(value: Array<ToolCall | ConstructorParameters<typeof ToolCall>[0]>);
    get is_complete_response(): boolean | undefined;
    set is_complete_response(value: boolean | undefined);
    get structured_output(): unknown;
    set structured_output(value: unknown);
    get usage_metadata(): UsageMetadata | undefined;
    set usage_metadata(value: ConstructorParameters<typeof UsageMetadata>[0] | undefined);
    toJSON(): Record<string, unknown>;
}
export declare class HookResult {
    allow: boolean;
    message: string;
    constructor(init?: Partial<HookResult>);
}
export declare class QuestionResponse {
    selectedOptionIds?: string[];
    freeformResponse: string;
    skipped: boolean;
    constructor(init?: Partial<QuestionResponse> & {
        selected_option_ids?: string[];
        freeform_response?: string;
    });
    get selected_option_ids(): string[] | undefined;
    set selected_option_ids(value: string[] | undefined);
    get freeform_response(): string;
    set freeform_response(value: string);
    toJSON(): {
        selected_option_ids?: string[];
        freeform_response: string;
        skipped: boolean;
    };
}
export declare class QuestionHookResult {
    responses: QuestionResponse[];
    cancelled: boolean;
    constructor(init: {
        responses: QuestionResponse[];
        cancelled?: boolean;
    });
    toJSON(): {
        responses: Array<ReturnType<QuestionResponse["toJSON"]>>;
        cancelled: boolean;
    };
}
export declare class AskQuestionOption {
    readonly id: string;
    readonly text: string;
    constructor(init: {
        id: string;
        text: string;
    });
    toJSON(): {
        id: string;
        text: string;
    };
}
export declare class AskQuestionEntry {
    readonly question: string;
    readonly options: AskQuestionOption[];
    readonly isMultiSelect: boolean;
    constructor(init: {
        question: string;
        options: Array<AskQuestionOption | {
            id: string;
            text: string;
        }>;
        isMultiSelect?: boolean;
        is_multi_select?: boolean;
    });
    get is_multi_select(): boolean;
    toJSON(): {
        question: string;
        options: Array<ReturnType<AskQuestionOption["toJSON"]>>;
        is_multi_select: boolean;
    };
}
export declare class AskQuestionInteractionSpec {
    readonly questions: AskQuestionEntry[];
    constructor(init: {
        questions: Array<AskQuestionEntry | ConstructorParameters<typeof AskQuestionEntry>[0]>;
    });
    toJSON(): {
        questions: Array<ReturnType<AskQuestionEntry["toJSON"]>>;
    };
}
export declare class AntigravityConnectionError extends Error {
    name: string;
}
export declare class AntigravityExecutionError extends Error {
    name: string;
}
export declare class AntigravityValidationError extends Error {
    name: string;
    errors: Array<Record<string, unknown>>;
    constructor(message: string, errors?: Array<Record<string, unknown>>);
    static fromPydantic(exc: unknown): AntigravityValidationError;
    static from_pydantic: typeof AntigravityValidationError.fromPydantic;
}
export declare enum TriggerDelivery {
    SEND_IMMEDIATELY = "send_immediately",
    WAIT_IDLE = "wait_idle"
}
export declare enum FileChangeKind {
    ADDED = "added",
    MODIFIED = "modified",
    DELETED = "deleted"
}
export declare class FileChange {
    readonly kind: FileChangeKind;
    readonly path: string;
    constructor(init: {
        kind: FileChangeKind;
        path: string;
    });
    toJSON(): {
        kind: FileChangeKind;
        path: string;
    };
}
export declare abstract class StreamChunk {
    readonly stepIndex: number;
    protected constructor(init: {
        stepIndex?: number;
        step_index?: number;
    });
    get step_index(): number;
}
export declare class Thought extends StreamChunk {
    readonly text: string;
    readonly signature?: Uint8Array;
    constructor(init: {
        stepIndex?: number;
        step_index?: number;
        text: string;
        signature?: Uint8Array;
    });
    toJSON(): {
        step_index: number;
        text: string;
        signature?: Uint8Array;
    };
}
export declare class Text extends StreamChunk {
    readonly text: string;
    constructor(init: {
        stepIndex?: number;
        step_index?: number;
        text: string;
    });
    toJSON(): {
        step_index: number;
        text: string;
    };
}
export type ResponseChunk = StreamChunk | ToolCall | ToolResult;
export interface StructuredOutputProvider {
    getLastStructuredOutput?: () => unknown | undefined;
    get_last_structured_output?: () => unknown | undefined;
    readonly lastTurnUsage?: UsageMetadata | undefined;
    readonly last_turn_usage?: UsageMetadata | undefined;
}
export declare class ChatResponse implements AsyncIterable<string> {
    #private;
    constructor(chunkStream: AsyncIterable<ResponseChunk> | AsyncIterator<ResponseChunk>, conversation: StructuredOutputProvider);
    get chunks(): AsyncIterable<ResponseChunk>;
    [Symbol.asyncIterator](): AsyncIterator<string>;
    get thoughts(): AsyncIterable<string>;
    get toolCalls(): AsyncIterable<ToolCall>;
    get tool_calls(): AsyncIterable<ToolCall>;
    resolve(): Promise<ResponseChunk[]>;
    text(): Promise<string>;
    structuredOutput(): Promise<unknown | undefined>;
    structured_output(): Promise<unknown | undefined>;
    get usageMetadata(): UsageMetadata | undefined;
    get usage_metadata(): UsageMetadata | undefined;
}
export declare const SUPPORTED_IMAGE_MIMES: Set<string>;
export declare const SUPPORTED_DOCUMENT_MIMES: Set<string>;
export declare const SUPPORTED_AUDIO_MIMES: Set<string>;
export declare const SUPPORTED_VIDEO_MIMES: Set<string>;
declare abstract class BaseMedia {
    #private;
    readonly mimeType: string;
    readonly description?: string;
    protected constructor(init: {
        data: Uint8Array | Buffer | ArrayBuffer | string;
        mimeType?: string;
        mime_type?: string;
        description?: string;
    });
    get data(): Uint8Array;
    get mime_type(): string;
    protected abstract supportedMimes(): Set<string>;
    protected validateMimeType(): void;
}
export declare class Image extends BaseMedia {
    constructor(init: {
        data: Uint8Array | Buffer | ArrayBuffer | string;
        mimeType?: string;
        mime_type?: string;
        description?: string;
    });
    protected supportedMimes(): Set<string>;
    static fromFile(path: string, description?: string): Image;
    static from_file(path: string, description?: string): Image;
}
export declare class Document extends BaseMedia {
    constructor(init: {
        data: Uint8Array | Buffer | ArrayBuffer | string;
        mimeType?: string;
        mime_type?: string;
        description?: string;
    });
    protected supportedMimes(): Set<string>;
    static fromFile(path: string, description?: string): Document;
    static from_file(path: string, description?: string): Document;
}
export declare class Audio extends BaseMedia {
    constructor(init: {
        data: Uint8Array | Buffer | ArrayBuffer | string;
        mimeType?: string;
        mime_type?: string;
        description?: string;
    });
    protected supportedMimes(): Set<string>;
    static fromFile(path: string, description?: string): Audio;
    static from_file(path: string, description?: string): Audio;
}
export declare class Video extends BaseMedia {
    constructor(init: {
        data: Uint8Array | Buffer | ArrayBuffer | string;
        mimeType?: string;
        mime_type?: string;
        description?: string;
    });
    protected supportedMimes(): Set<string>;
    static fromFile(path: string, description?: string): Video;
    static from_file(path: string, description?: string): Video;
}
export type ContentPrimitive = string | Image | Document | Audio | Video;
export type Content = ContentPrimitive | ContentPrimitive[];
export declare function fromFile(path: string, description?: string): Image | Document | Audio | Video;
export declare const from_file: typeof fromFile;
export {};
//# sourceMappingURL=types.d.ts.map