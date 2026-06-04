import { accessSync, constants, existsSync } from "node:fs";
import { spawn } from "node:child_process";
import { delimiter, dirname, join } from "node:path";
import { platform, release } from "node:os";
import { fileURLToPath } from "node:url";
import { AskQuestionEntry, AskQuestionInteractionSpec, AskQuestionOption, AntigravityConnectionError, AntigravityExecutionError, AntigravityValidationError, Audio, BuiltinTools, CapabilitiesConfig, CustomSystemInstructions, Document, GeminiConfig, Image, SystemInstructionSection, TemplatedSystemInstructions, Video, Step, StepSource, StepStatus, StepTarget, StepType, ToolCall, ToolResult, UsageMetadata, } from "../../types.js";
import { ConnectionStrategy } from "../connection.js";
import { ToolRunner, ToolWithSchema } from "../../tools/tool-runner.js";
import { OperationContext, TurnContext } from "../../hooks/hooks.js";
import { EditFileResult, FindFileResult, GenerateImageResult, ListDirectoryEntry, ListDirectoryResult, RunCommandResult, SearchDirectoryResult, } from "./types.js";
const SOURCE_MAP = new Map([
    ["SOURCE_SYSTEM", StepSource.SYSTEM],
    ["SOURCE_USER", StepSource.USER],
    ["SOURCE_MODEL", StepSource.MODEL],
]);
const STATUS_MAP = new Map([
    ["STATE_ACTIVE", StepStatus.ACTIVE],
    ["STATE_DONE", StepStatus.DONE],
    ["STATE_WAITING_FOR_USER", StepStatus.WAITING_FOR_USER],
    ["STATE_ERROR", StepStatus.ERROR],
    ["STATE_CANCELED", StepStatus.CANCELED],
    ["STATE_TERMINAL_ERROR", StepStatus.TERMINAL_ERROR],
]);
const BUILTIN_TOOL_PROTO_FIELDS = new Map([
    [BuiltinTools.CREATE_FILE, "create_file"],
    [BuiltinTools.EDIT_FILE, "edit_file"],
    [BuiltinTools.FIND_FILE, "find_file"],
    [BuiltinTools.LIST_DIR, "list_directory"],
    [BuiltinTools.RUN_COMMAND, "run_command"],
    [BuiltinTools.SEARCH_DIR, "search_directory"],
    [BuiltinTools.VIEW_FILE, "view_file"],
    [BuiltinTools.START_SUBAGENT, "invoke_subagent"],
    [BuiltinTools.GENERATE_IMAGE, "generate_image"],
    [BuiltinTools.FINISH, "finish"],
]);
function makeStepId(trajectoryId, stepIndex) {
    return trajectoryId ? `${trajectoryId}:${stepIndex}` : String(stepIndex);
}
export function normalizeWirePath(path) {
    try {
        const url = new URL(path);
        if (url.protocol === "file:") {
            return fileURLToPath(url);
        }
    }
    catch {
        // Plain filesystem path, not a URL.
    }
    return path;
}
export const normalize_wire_path = normalizeWirePath;
const IDLE_SENTINEL = Symbol("idle");
const CLOSE_SENTINEL = Symbol("close");
class StepTracker {
    #state = "";
    #handledRequests = new Set();
    updateState(newState) {
        if (this.#state === "STATE_WAITING_FOR_USER" && newState !== "STATE_WAITING_FOR_USER") {
            this.#handledRequests.clear();
        }
        this.#state = newState;
    }
    markHandled(requestType) {
        if (this.#handledRequests.has(requestType)) {
            return false;
        }
        this.#handledRequests.add(requestType);
        return true;
    }
}
function asRecord(value) {
    return value && typeof value === "object" && !Array.isArray(value)
        ? value
        : {};
}
function asString(value, fallback = "") {
    return typeof value === "string" ? value : fallback;
}
function asNumber(value, fallback = 0) {
    return typeof value === "number" ? value : fallback;
}
function hasNonEmptyValue(value) {
    if (Array.isArray(value)) {
        return value.length > 0;
    }
    return Boolean(value);
}
function selectedChoiceIndex(value) {
    if (typeof value === "number" && Number.isInteger(value)) {
        return value - 1;
    }
    if (typeof value !== "string") {
        return undefined;
    }
    const trimmed = value.trim();
    if (!/^[+-]?\d+$/.test(trimmed)) {
        return undefined;
    }
    return Number.parseInt(trimmed, 10) - 1;
}
function formatErrorForWire(error) {
    if (error instanceof Error) {
        return `${error.name}: ${error.message}`;
    }
    return String(error);
}
function pendingBuiltinKey(trajectoryId, stepIndex) {
    return `${trajectoryId}:${stepIndex}`;
}
function hasOwnField(object, field) {
    return Object.prototype.hasOwnProperty.call(object, field);
}
function extractToolResult(stepUpdate) {
    if (hasOwnField(stepUpdate, "run_command")) {
        const runCommand = asRecord(stepUpdate.run_command);
        const output = asString(runCommand.combined_output);
        return output ? new RunCommandResult({ output }) : undefined;
    }
    if (hasOwnField(stepUpdate, "list_directory")) {
        const listDirectory = asRecord(stepUpdate.list_directory);
        const listResults = listDirectory.results;
        if (Array.isArray(listResults) && listResults.length) {
            return new ListDirectoryResult({
                entries: listResults.map((entry) => {
                    const record = asRecord(entry);
                    return new ListDirectoryEntry({
                        name: asString(record.name),
                        isDirectory: Boolean(record.is_directory),
                        fileSize: asNumber(record.file_size),
                    });
                }),
            });
        }
        return undefined;
    }
    if (hasOwnField(stepUpdate, "find_file")) {
        const findFile = asRecord(stepUpdate.find_file);
        const output = asString(findFile.output);
        return output ? new FindFileResult({ output }) : undefined;
    }
    if (hasOwnField(stepUpdate, "search_directory")) {
        const searchDirectory = asRecord(stepUpdate.search_directory);
        const numResults = asNumber(searchDirectory.num_results);
        return numResults
            ? new SearchDirectoryResult({
                numResults,
            })
            : undefined;
    }
    if (hasOwnField(stepUpdate, "edit_file")) {
        const editFile = asRecord(stepUpdate.edit_file);
        return hasNonEmptyValue(editFile.diff_block)
            ? new EditFileResult({ summary: asString(stepUpdate.text) })
            : undefined;
    }
    if (hasOwnField(stepUpdate, "generate_image")) {
        const generateImage = asRecord(stepUpdate.generate_image);
        const imageName = asString(generateImage.image_name);
        return imageName
            ? new GenerateImageResult({
                imageName,
            })
            : undefined;
    }
    return undefined;
}
export class LocalConnectionStep extends Step {
    cascadeId = "";
    trajectoryId = "";
    httpCode = 0;
    constructor(init = {}) {
        super(init);
        Object.assign(this, init);
    }
    get cascade_id() {
        return this.cascadeId;
    }
    set cascade_id(value) {
        this.cascadeId = value;
    }
    get trajectory_id() {
        return this.trajectoryId;
    }
    set trajectory_id(value) {
        this.trajectoryId = value;
    }
    get http_code() {
        return this.httpCode;
    }
    set http_code(value) {
        this.httpCode = value;
    }
    static fromObject(stepObject) {
        const trajectoryId = asString(stepObject.trajectory_id);
        const stepIndex = asNumber(stepObject.step_index);
        let activeToolName;
        let activeToolArgs = {};
        for (const [toolName, protoField] of BUILTIN_TOOL_PROTO_FIELDS) {
            if (stepObject[protoField] !== undefined) {
                activeToolName = toolName;
                activeToolArgs = asRecord(stepObject[protoField]);
                break;
            }
        }
        let canonicalPath;
        if (activeToolName) {
            for (const pathKey of ["path", "file_path", "TargetFile", "directory_path"]) {
                const rawPath = activeToolArgs[pathKey];
                if (typeof rawPath === "string") {
                    const normalized = normalizeWirePath(rawPath);
                    activeToolArgs[pathKey] = normalized;
                    canonicalPath = normalized;
                }
            }
        }
        const toolCalls = activeToolName
            ? [
                new ToolCall({
                    name: activeToolName,
                    args: activeToolArgs,
                    id: makeStepId(trajectoryId, stepIndex),
                    canonicalPath,
                }),
            ]
            : [];
        let type = StepType.UNKNOWN;
        if (stepObject.compaction !== undefined) {
            type = StepType.COMPACTION;
        }
        else if (stepObject.finish !== undefined) {
            type = StepType.FINISH;
        }
        else if (activeToolName ||
            [...BUILTIN_TOOL_PROTO_FIELDS.values()].some((field) => stepObject[field] !== undefined)) {
            type = StepType.TOOL_CALL;
        }
        else if (stepObject.text) {
            type = StepType.TEXT_RESPONSE;
        }
        let structuredOutput;
        if (type === StepType.FINISH) {
            const outputString = asString(asRecord(stepObject.finish).output_string);
            if (outputString) {
                try {
                    structuredOutput = JSON.parse(outputString);
                }
                catch {
                    structuredOutput = undefined;
                }
            }
        }
        const errorField = asRecord(stepObject.error);
        const error = asString(errorField.error_message) || asString(stepObject.error_message);
        const httpCode = asNumber(errorField.http_code);
        const source = SOURCE_MAP.get(asString(stepObject.source)) ?? StepSource.UNKNOWN;
        const status = STATUS_MAP.get(asString(stepObject.state)) ?? StepStatus.UNKNOWN;
        const target = asString(stepObject.target) === StepTarget.USER
            ? StepTarget.USER
            : asString(stepObject.target) === StepTarget.ENVIRONMENT
                ? StepTarget.ENVIRONMENT
                : asString(stepObject.target) === StepTarget.UNSPECIFIED
                    ? StepTarget.UNSPECIFIED
                    : StepTarget.UNKNOWN;
        const content = asString(stepObject.text);
        return new LocalConnectionStep({
            id: makeStepId(trajectoryId, stepIndex),
            stepIndex,
            cascadeId: asString(stepObject.cascade_id),
            trajectoryId,
            type,
            source,
            status,
            target,
            content,
            contentDelta: asString(stepObject.text_delta),
            thinking: asString(stepObject.thinking),
            thinkingDelta: asString(stepObject.thinking_delta),
            toolCalls,
            error,
            httpCode,
            isCompleteResponse: source === StepSource.MODEL &&
                status === StepStatus.DONE &&
                Boolean(content) &&
                target === StepTarget.USER,
            structuredOutput,
        });
    }
    static from_dict(stepObject) {
        return this.fromObject(stepObject);
    }
    static fromOutputEvent(event) {
        const stepUpdate = event.step_update;
        if (!stepUpdate || typeof stepUpdate !== "object") {
            return undefined;
        }
        const step = LocalConnectionStep.fromObject(stepUpdate);
        const usage = asRecord(event.usage_metadata);
        if (Object.keys(usage).length) {
            step.usageMetadata = new UsageMetadata({
                promptTokenCount: usage.prompt_token_count,
                cachedContentTokenCount: usage.cached_content_token_count,
                candidatesTokenCount: usage.candidates_token_count,
                thoughtsTokenCount: usage.thoughts_token_count,
                totalTokenCount: usage.total_token_count,
            });
        }
        return step;
    }
    static from_output_event(event) {
        return this.fromOutputEvent(event);
    }
}
class AsyncQueue {
    #items = [];
    #waiters = [];
    push(item) {
        const waiter = this.#waiters.shift();
        if (waiter) {
            waiter(item);
            return;
        }
        this.#items.push(item);
    }
    async shift() {
        const item = this.#items.shift();
        if (item !== undefined) {
            return item;
        }
        return await new Promise((resolve) => this.#waiters.push(resolve));
    }
    clear() {
        this.#items = [];
    }
    get isEmpty() {
        return this.#items.length === 0;
    }
}
class BufferedReader {
    #stream;
    #buffer = Buffer.alloc(0);
    #ended = false;
    #error;
    #waiters = [];
    constructor(stream) {
        this.#stream = stream;
        stream.on("data", (chunk) => {
            this.#buffer = Buffer.concat([this.#buffer, chunk]);
            this.#notify();
        });
        stream.on("end", () => {
            this.#ended = true;
            this.#notify();
        });
        stream.on("error", (error) => {
            this.#error = error;
            this.#notify();
        });
    }
    async readExact(length) {
        while (this.#buffer.length < length) {
            if (this.#error) {
                throw this.#error;
            }
            if (this.#ended) {
                throw new Error("Stream ended before enough bytes were available.");
            }
            await new Promise((resolve) => this.#waiters.push(resolve));
        }
        const out = this.#buffer.subarray(0, length);
        this.#buffer = this.#buffer.subarray(length);
        return out;
    }
    #notify() {
        const waiters = this.#waiters.splice(0);
        for (const waiter of waiters) {
            waiter();
        }
    }
}
function encodeVarint(value) {
    const bytes = [];
    let current = value >>> 0;
    while (current >= 0x80) {
        bytes.push((current & 0x7f) | 0x80);
        current >>>= 7;
    }
    bytes.push(current);
    return bytes;
}
function encodeStringField(field, value) {
    if (!value) {
        return [];
    }
    const data = Buffer.from(value, "utf8");
    return [...encodeVarint((field << 3) | 2), ...encodeVarint(data.length), ...data];
}
function encodeUInt32Field(field, value) {
    if (value === undefined) {
        return [];
    }
    return [...encodeVarint((field << 3) | 0), ...encodeVarint(value)];
}
function encodeMessageField(field, data) {
    if (!data.length) {
        return [];
    }
    return [...encodeVarint((field << 3) | 2), ...encodeVarint(data.length), ...data];
}
function encodeClientInfo(info) {
    return Buffer.from([
        ...encodeStringField(1, info.language),
        ...encodeStringField(2, info.version),
        ...encodeStringField(3, info.languageVersion),
    ]);
}
function encodeInputConfig(config) {
    const clientInfo = config.clientInfo ? encodeClientInfo(config.clientInfo) : Buffer.alloc(0);
    return Buffer.from([
        ...encodeStringField(1, config.storageDirectory ?? ""),
        ...encodeUInt32Field(2, config.port),
        ...encodeStringField(3, config.bindAddress ?? ""),
        ...encodeMessageField(4, clientInfo),
    ]);
}
function decodeVarint(buffer, offset) {
    let shift = 0;
    let result = 0;
    let pos = offset;
    while (pos < buffer.length) {
        const byte = buffer[pos++];
        result |= (byte & 0x7f) << shift;
        if ((byte & 0x80) === 0) {
            return [result >>> 0, pos];
        }
        shift += 7;
    }
    throw new Error("Invalid protobuf varint.");
}
function decodeOutputConfig(buffer) {
    let pos = 0;
    let portNumber = 0;
    let apiKey = "";
    while (pos < buffer.length) {
        const [tag, afterTag] = decodeVarint(buffer, pos);
        pos = afterTag;
        const field = tag >> 3;
        const wireType = tag & 0x7;
        if (wireType === 0) {
            const [value, afterValue] = decodeVarint(buffer, pos);
            pos = afterValue;
            if (field === 1) {
                portNumber = value;
            }
        }
        else if (wireType === 2) {
            const [length, afterLength] = decodeVarint(buffer, pos);
            pos = afterLength;
            const value = buffer.subarray(pos, pos + length);
            pos += length;
            if (field === 2) {
                apiKey = value.toString("utf8");
            }
        }
        else {
            throw new Error(`Unsupported OutputConfig wire type: ${wireType}`);
        }
    }
    return { port: portNumber, apiKey };
}
function withLengthPrefix(payload) {
    const length = Buffer.alloc(4);
    length.writeUInt32LE(payload.length, 0);
    return Buffer.concat([length, payload]);
}
function camelToSnake(key) {
    return key.replace(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`);
}
function snakeToCamel(key) {
    return key.replace(/_([a-z])/g, (_match, letter) => letter.toUpperCase());
}
function keysToSnake(value) {
    if (Array.isArray(value)) {
        return value.map(keysToSnake);
    }
    if (value && typeof value === "object") {
        return Object.fromEntries(Object.entries(value).map(([key, child]) => [
            camelToSnake(key),
            keysToSnake(child),
        ]));
    }
    return value;
}
function keysToCamel(value) {
    if (Array.isArray(value)) {
        return value.map(keysToCamel);
    }
    if (value && typeof value === "object") {
        return Object.fromEntries(Object.entries(value)
            .filter(([, child]) => child !== undefined)
            .map(([key, child]) => [snakeToCamel(key), keysToCamel(child)]));
    }
    return value;
}
function serializeEvent(event) {
    return JSON.stringify(keysToCamel(event));
}
function parseEvent(raw) {
    const text = typeof raw === "string"
        ? raw
        : raw instanceof Buffer
            ? raw.toString("utf8")
            : raw instanceof ArrayBuffer
                ? Buffer.from(raw).toString("utf8")
                : String(raw);
    return keysToSnake(JSON.parse(text));
}
function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}
function onceProcessExit(process) {
    return new Promise((resolve) => {
        process.once("exit", () => resolve());
    });
}
function websocketOpen(url, apiKey) {
    return new Promise((resolve, reject) => {
        const ws = new WebSocket(url, apiKey ? { headers: { "x-goog-api-key": apiKey } } : undefined);
        ws.addEventListener("open", () => resolve(ws), { once: true });
        ws.addEventListener("error", () => reject(new Error(`Failed to connect to WebSocket at ${url}`)), { once: true });
    });
}
function toPromptEvent(prompt) {
    if (prompt === undefined) {
        return { user_input: "" };
    }
    if (typeof prompt === "string") {
        return { user_input: prompt };
    }
    const parts = (Array.isArray(prompt) ? prompt : [prompt]).map((part) => {
        if (typeof part === "string") {
            return { text: part };
        }
        if (part instanceof Image ||
            part instanceof Document ||
            part instanceof Audio ||
            part instanceof Video) {
            return {
                media: {
                    mime_type: part.mimeType,
                    description: part.description,
                    data: Buffer.from(part.data).toString("base64"),
                },
            };
        }
        throw new TypeError(`Unsupported prompt content type: ${typeof part}`);
    });
    return { complex_user_input: { parts } };
}
export function callableToToolProto(fn, toolRunner) {
    if (fn instanceof ToolWithSchema) {
        return {
            name: fn.__name__,
            description: fn.__doc__ || "",
            parameters_json_schema: JSON.stringify(fn.input_schema),
        };
    }
    const toolName = fn.name;
    const runner = toolRunner?.tools[toolName] ? toolRunner : new ToolRunner([fn]);
    return {
        name: toolName,
        description: runner.getToolDescription(toolName),
        parameters_json_schema: JSON.stringify(runner.getPublicInputSchema(toolName)),
    };
}
export const callable_to_tool_proto = callableToToolProto;
function toolResultToWire(result) {
    if (result.error !== undefined && result.error !== null) {
        return { error: result.error };
    }
    const output = normalizeToolOutput(result.result);
    if (output && typeof output === "object" && !Array.isArray(output)) {
        return output;
    }
    return { result: output };
}
function normalizeToolOutput(value, seen = new WeakSet()) {
    if (value === undefined || value === null || typeof value !== "object") {
        return value;
    }
    if (seen.has(value)) {
        return String(value);
    }
    seen.add(value);
    if (value instanceof Date) {
        return value.toISOString();
    }
    if (value instanceof Uint8Array) {
        return Buffer.from(value).toString("utf8");
    }
    if (value instanceof ArrayBuffer) {
        return Buffer.from(value).toString("utf8");
    }
    if (value instanceof Set) {
        return [...value].map((item) => normalizeToolOutput(item, seen));
    }
    if (value instanceof Map) {
        return Object.fromEntries([...value.entries()].map(([key, item]) => [String(key), normalizeToolOutput(item, seen)]));
    }
    if ("toJSON" in value && typeof value.toJSON === "function") {
        try {
            return normalizeToolOutput(value.toJSON(), seen);
        }
        catch {
            return String(value);
        }
    }
    if (Array.isArray(value)) {
        return value.map((item) => normalizeToolOutput(item, seen));
    }
    if (Object.getPrototypeOf(value) === Object.prototype) {
        return Object.fromEntries(Object.entries(value).map(([key, item]) => [
            key,
            normalizeToolOutput(item, seen),
        ]));
    }
    return String(value);
}
export class LocalConnection {
    #process;
    #ws;
    #toolRunner;
    #hookRunner;
    #stepQueue = new AsyncQueue();
    #idle = true;
    #idleWaiters = [];
    #isReceiving = false;
    #currentTurnContext;
    #cancelled = false;
    #cancelledMessage = "";
    #conversationId = "";
    #stderrLines = [];
    #disconnecting = false;
    #stepTrackers = new Map();
    #pendingBuiltinToolCalls = new Map();
    #activeSubagentIds = new Set();
    #subagentResponses = new Map();
    #parentIdle = true;
    constructor(init) {
        this.#process = init.process;
        this.#ws = init.ws;
        this.#toolRunner = init.toolRunner;
        this.#hookRunner = init.hookRunner;
        this.#conversationId = init.conversationId ?? "";
        this.#startReader();
        this.#startStderrReader();
    }
    get isIdle() {
        return this.#idle;
    }
    get is_idle() {
        return this.isIdle;
    }
    get conversationId() {
        return this.#conversationId;
    }
    get conversation_id() {
        return this.conversationId;
    }
    async send(prompt) {
        this.#cancelled = false;
        this.#setIdle(false);
        this.#parentIdle = false;
        this.#activeSubagentIds.clear();
        this.#subagentResponses.clear();
        if (this.#hookRunner) {
            const [result, turnContext] = await this.#hookRunner.dispatchPreTurn(prompt);
            this.#currentTurnContext = turnContext;
            if (!result.allow) {
                this.#cancelled = true;
                this.#cancelledMessage = result.message || "Turn execution denied by hook.";
                this.#setIdle(true);
                return;
            }
        }
        this.#sendJson(toPromptEvent(prompt));
    }
    async *receiveSteps() {
        if (this.#isReceiving) {
            throw new Error("Concurrent receiveSteps() calls are not supported on this connection.");
        }
        this.#isReceiving = true;
        try {
            if (this.#cancelled) {
                yield new LocalConnectionStep({
                    status: StepStatus.CANCELED,
                    error: this.#cancelledMessage,
                    source: StepSource.SYSTEM,
                    type: StepType.SYSTEM_MESSAGE,
                });
                return;
            }
            if (this.#idle && this.#stepQueue.isEmpty) {
                return;
            }
            while (true) {
                if (this.#idle && this.#stepQueue.isEmpty) {
                    return;
                }
                const item = await this.#stepQueue.shift();
                if (item === IDLE_SENTINEL) {
                    continue;
                }
                if (item === CLOSE_SENTINEL) {
                    return;
                }
                if (item instanceof Error) {
                    throw item;
                }
                yield item;
                if (item.status === StepStatus.ERROR &&
                    item.source === StepSource.SYSTEM &&
                    [400, 401, 403].includes(item.httpCode)) {
                    throw new AntigravityConnectionError(item.error || "System error occurred.");
                }
                if (item.status === StepStatus.TERMINAL_ERROR) {
                    throw new AntigravityExecutionError(item.error || "Terminal error occurred during execution");
                }
                if (item.source === StepSource.MODEL &&
                    item.target === StepTarget.USER &&
                    [
                        StepStatus.DONE,
                        StepStatus.ERROR,
                        StepStatus.CANCELED,
                        StepStatus.TERMINAL_ERROR,
                    ].includes(item.status)) {
                    if (this.#hookRunner && this.#currentTurnContext) {
                        await this.#hookRunner.dispatchPostTurn(this.#currentTurnContext, item.content || "");
                        this.#currentTurnContext = undefined;
                    }
                }
            }
        }
        finally {
            this.#isReceiving = false;
        }
    }
    receive_steps() {
        return this.receiveSteps();
    }
    async disconnect() {
        this.#disconnecting = true;
        try {
            await this.#hookRunner?.dispatchSessionEnd();
        }
        finally {
            try {
                this.#ws.close();
            }
            catch {
                // Ignore close failures during shutdown.
            }
            this.#process.stdin.end();
            await Promise.race([onceProcessExit(this.#process), sleep(5000)]);
            if (!this.#process.killed && this.#process.exitCode === null) {
                this.#process.kill("SIGTERM");
                await Promise.race([onceProcessExit(this.#process), sleep(1000)]);
            }
            if (!this.#process.killed && this.#process.exitCode === null) {
                this.#process.kill("SIGKILL");
            }
            this.#setIdle(true);
            this.#stepQueue.push(CLOSE_SENTINEL);
        }
    }
    async cancel() {
        this.#sendJson({ halt_request: true });
    }
    async delete() { }
    async signalIdle() {
        this.#setIdle(true);
        this.#stepQueue.push(IDLE_SENTINEL);
    }
    signal_idle() {
        return this.signalIdle();
    }
    async waitForIdle() {
        if (this.#idle) {
            this.#stepQueue.clear();
            return;
        }
        await new Promise((resolve) => this.#idleWaiters.push(resolve));
        this.#stepQueue.clear();
    }
    wait_for_idle() {
        return this.waitForIdle();
    }
    async waitForWakeup(_timeout = 300) {
        return false;
    }
    wait_for_wakeup(timeout = 300) {
        return this.waitForWakeup(timeout);
    }
    async sendToolResults(results) {
        for (const result of results) {
            if (!result.id) {
                throw new Error(`ToolResult for '${result.name}' is missing an id. The LocalConnection protocol requires an id to correlate results with calls.`);
            }
            this.#sendJson({
                tool_response: {
                    id: result.id,
                    response_json: JSON.stringify(toolResultToWire(result)),
                },
            });
        }
    }
    send_tool_results(results) {
        return this.sendToolResults(results);
    }
    async sendTriggerNotification(content) {
        this.#sendJson({ automated_trigger: content });
    }
    send_trigger_notification(content) {
        return this.sendTriggerNotification(content);
    }
    #sendJson(event) {
        if (this.#ws.readyState !== WebSocket.OPEN) {
            throw new AntigravityConnectionError("Local harness WebSocket is not open.");
        }
        this.#ws.send(serializeEvent(event));
    }
    #setIdle(value) {
        this.#idle = value;
        if (value) {
            const waiters = this.#idleWaiters.splice(0);
            for (const waiter of waiters) {
                waiter();
            }
        }
    }
    #startReader() {
        this.#ws.addEventListener("message", (message) => {
            void this.#handleRawMessage(message.data).catch((error) => {
                this.#stepQueue.push(error instanceof Error ? error : new Error(String(error)));
            });
        });
        this.#ws.addEventListener("close", () => {
            if (!this.#disconnecting) {
                const stderr = this.#stderrLines.slice(-20).join("\n");
                this.#stepQueue.push(new AntigravityConnectionError(`Harness WebSocket closed unexpectedly.${stderr ? `\nHarness stderr:\n${stderr}` : ""}`));
            }
            this.#setIdle(true);
            this.#stepQueue.push(CLOSE_SENTINEL);
        });
        this.#ws.addEventListener("error", () => {
            this.#stepQueue.push(new AntigravityConnectionError("Harness WebSocket error."));
        });
    }
    #startStderrReader() {
        this.#process.stderr.setEncoding("utf8");
        this.#process.stderr.on("data", (chunk) => {
            for (const line of chunk.split(/\r?\n/).filter(Boolean)) {
                this.#stderrLines.push(line);
                if (this.#stderrLines.length > 100) {
                    this.#stderrLines.shift();
                }
            }
        });
    }
    async #handleRawMessage(raw) {
        const event = parseEvent(raw);
        if (event.step_update) {
            const stepUpdate = asRecord(event.step_update);
            const stepKey = pendingBuiltinKey(asString(stepUpdate.trajectory_id), asNumber(stepUpdate.step_index));
            let tracker = this.#stepTrackers.get(stepKey);
            if (!tracker) {
                tracker = new StepTracker();
                this.#stepTrackers.set(stepKey, tracker);
            }
            tracker.updateState(asString(stepUpdate.state));
            const step = LocalConnectionStep.fromOutputEvent(event);
            if (step) {
                if (step.cascadeId && step.cascadeId === step.trajectoryId) {
                    this.#conversationId = step.cascadeId;
                }
                this.#trackSubagentResponse(step);
                this.#stepQueue.push(step);
                if (step.type === StepType.COMPACTION && this.#hookRunner) {
                    void this.#hookRunner.dispatchCompaction(this.#getTurnContext(), step).catch((error) => {
                        this.#stepQueue.push(error instanceof Error ? error : new Error(String(error)));
                    });
                }
                this.#dispatchBuiltinToolCompletion(stepUpdate, step);
            }
            if (stepUpdate.tool_confirmation_request !== undefined &&
                tracker.markHandled("tool_confirmation_request")) {
                void this.#handleToolConfirmationRequest(stepUpdate).catch((error) => {
                    this.#stepQueue.push(error instanceof Error ? error : new Error(String(error)));
                });
            }
            if (stepUpdate.questions_request !== undefined && tracker.markHandled("questions_request")) {
                void this.#handleQuestionRequest(stepUpdate).catch((error) => {
                    this.#stepQueue.push(error instanceof Error ? error : new Error(String(error)));
                });
            }
            return;
        }
        if (event.trajectory_state_update) {
            const update = asRecord(event.trajectory_state_update);
            const trajectoryId = asString(update.trajectory_id);
            const isSubagent = Boolean(this.#conversationId && trajectoryId && trajectoryId !== this.#conversationId);
            if (asString(update.state) === "STATE_RUNNING") {
                this.#setIdle(false);
                if (isSubagent) {
                    this.#activeSubagentIds.add(trajectoryId);
                }
                else {
                    this.#parentIdle = false;
                }
            }
            else if (asString(update.state) === "STATE_IDLE") {
                if (isSubagent) {
                    this.#activeSubagentIds.delete(trajectoryId);
                    await this.#dispatchSubagentToolCompletion(trajectoryId);
                }
                else {
                    this.#parentIdle = true;
                }
                if (this.#parentIdle && this.#activeSubagentIds.size === 0) {
                    this.#setIdle(true);
                    this.#stepQueue.push(IDLE_SENTINEL);
                }
            }
            return;
        }
        if (event.tool_call) {
            await this.#handleToolCall(asRecord(event.tool_call));
        }
    }
    #getTurnContext() {
        if (!this.#hookRunner) {
            throw new Error("No HookRunner is configured.");
        }
        return this.#currentTurnContext ?? new TurnContext(this.#hookRunner.sessionContext);
    }
    #trackSubagentResponse(step) {
        if (this.#conversationId &&
            step.trajectoryId &&
            step.trajectoryId !== this.#conversationId &&
            step.source === StepSource.MODEL &&
            step.content) {
            this.#subagentResponses.set(step.trajectoryId, step.content);
        }
    }
    async #dispatchSubagentToolCompletion(trajectoryId) {
        if (!this.#hookRunner) {
            this.#subagentResponses.delete(trajectoryId);
            return;
        }
        const response = this.#subagentResponses.get(trajectoryId) ?? "";
        this.#subagentResponses.delete(trajectoryId);
        const result = new ToolResult({
            name: BuiltinTools.START_SUBAGENT,
            result: response || trajectoryId,
        });
        await this.#hookRunner.dispatchPostToolCall(new OperationContext(this.#getTurnContext()), result);
    }
    async #handleToolConfirmationRequest(stepUpdate) {
        try {
            let action = "pre_request_host_tool_request";
            let args = {};
            for (const [toolName, protoField] of BUILTIN_TOOL_PROTO_FIELDS) {
                if (stepUpdate[protoField] !== undefined) {
                    action = toolName;
                    args = asRecord(stepUpdate[protoField]);
                    break;
                }
            }
            if (stepUpdate.request_text) {
                args.request_text = stepUpdate.request_text;
            }
            let canonicalPath;
            for (const pathKey of ["path", "file_path", "TargetFile", "directory_path"]) {
                const rawPath = args[pathKey];
                if (typeof rawPath === "string") {
                    const normalized = normalizeWirePath(rawPath);
                    args[pathKey] = normalized;
                    canonicalPath = normalized;
                }
            }
            const toolCall = new ToolCall({
                id: makeStepId(asString(stepUpdate.trajectory_id), asNumber(stepUpdate.step_index)),
                name: action,
                args,
                canonicalPath,
            });
            let accepted = true;
            let opContext;
            if (action !== "pre_request_host_tool_request" && this.#hookRunner) {
                const [result, transformedCall, context] = await this.#hookRunner.dispatchPreToolCall(this.#getTurnContext(), toolCall);
                opContext = context;
                toolCall.args = transformedCall.args;
                accepted = result.allow;
            }
            if (accepted && action !== "pre_request_host_tool_request" && this.#hookRunner && opContext) {
                this.#pendingBuiltinToolCalls.set(pendingBuiltinKey(asString(stepUpdate.trajectory_id), asNumber(stepUpdate.step_index)), { toolCall, operationContext: opContext });
            }
            this.#sendToolConfirmation(stepUpdate, accepted);
        }
        catch {
            this.#sendToolConfirmation(stepUpdate, false);
        }
    }
    #dispatchBuiltinToolCompletion(stepUpdate, step) {
        if (!this.#hookRunner) {
            return;
        }
        const key = pendingBuiltinKey(step.trajectoryId, step.stepIndex);
        const pending = this.#pendingBuiltinToolCalls.get(key);
        if (!pending) {
            return;
        }
        if (step.status === StepStatus.DONE) {
            this.#pendingBuiltinToolCalls.delete(key);
            const result = new ToolResult({
                id: pending.toolCall.id,
                name: pending.toolCall.name,
                result: extractToolResult(stepUpdate) ?? step.content,
            });
            void this.#hookRunner
                .dispatchPostToolCall(pending.operationContext, result)
                .catch((error) => {
                this.#stepQueue.push(error instanceof Error ? error : new Error(String(error)));
            });
        }
        else if (step.status === StepStatus.ERROR) {
            this.#pendingBuiltinToolCalls.delete(key);
            const error = new Error(step.error || step.content || "Built-in tool failed");
            void this.#hookRunner
                .dispatchOnToolError(pending.operationContext, error)
                .catch((hookError) => {
                this.#stepQueue.push(hookError instanceof Error ? hookError : new Error(String(hookError)));
            });
        }
    }
    #sendToolConfirmation(stepUpdate, accepted) {
        this.#sendJson({
            tool_confirmation: {
                trajectory_id: asString(stepUpdate.trajectory_id),
                step_index: asNumber(stepUpdate.step_index),
                accepted,
            },
        });
    }
    async #handleQuestionRequest(stepUpdate) {
        try {
            const rawQuestions = asRecord(stepUpdate.questions_request).questions;
            const questionsArray = Array.isArray(rawQuestions) ? rawQuestions : [];
            const entries = [];
            const originalIndexes = [];
            for (const [index, rawQuestion] of questionsArray.entries()) {
                const multipleChoice = asRecord(asRecord(rawQuestion).multiple_choice);
                if (!Object.keys(multipleChoice).length) {
                    continue;
                }
                entries.push(new AskQuestionEntry({
                    question: asString(multipleChoice.question),
                    options: (Array.isArray(multipleChoice.choices) ? multipleChoice.choices : []).map((choice, optionIndex) => new AskQuestionOption({
                        id: String(optionIndex + 1),
                        text: String(choice),
                    })),
                    isMultiSelect: Boolean(multipleChoice.is_multi_select),
                }));
                originalIndexes.push(index);
            }
            const answers = questionsArray.map(() => ({ unanswered: true }));
            if (this.#hookRunner && entries.length) {
                const [, response] = await this.#hookRunner.dispatchInteraction(this.#getTurnContext(), new AskQuestionInteractionSpec({ questions: entries }));
                const responses = asRecord(response).responses;
                if (Array.isArray(responses)) {
                    for (const [responseIndex, rawResponse] of responses.entries()) {
                        const originalIndex = originalIndexes[responseIndex];
                        if (originalIndex === undefined) {
                            continue;
                        }
                        const responseRecord = asRecord(rawResponse);
                        if (responseRecord.skipped) {
                            answers[originalIndex] = { unanswered: true };
                        }
                        else {
                            answers[originalIndex] = {
                                multiple_choice_answer: {
                                    selected_choice_indices: (Array.isArray(responseRecord.selectedOptionIds)
                                        ? responseRecord.selectedOptionIds
                                        : Array.isArray(responseRecord.selected_option_ids)
                                            ? responseRecord.selected_option_ids
                                            : [])
                                        .map(selectedChoiceIndex)
                                        .filter((id) => id !== undefined),
                                    freeform_response: asString(responseRecord.freeformResponse) ||
                                        asString(responseRecord.freeform_response),
                                },
                            };
                        }
                    }
                }
            }
            this.#sendQuestionResponse(stepUpdate, answers);
        }
        catch (error) {
            this.#sendQuestionResponse(stepUpdate, [
                {
                    multiple_choice_answer: {
                        freeform_response: `SDK error processing question: ${error instanceof Error ? error.message : String(error)}`,
                    },
                },
            ]);
        }
    }
    #sendQuestionResponse(stepUpdate, answers) {
        this.#sendJson({
            question_response: {
                trajectory_id: asString(stepUpdate.trajectory_id),
                step_index: asNumber(stepUpdate.step_index),
                response: answers.length ? { answers } : {},
            },
        });
    }
    async #handleToolCall(toolCallWire) {
        const argsJson = asString(toolCallWire.arguments_json, "{}");
        let args;
        try {
            args = JSON.parse(argsJson);
        }
        catch {
            args = {};
        }
        const toolCall = new ToolCall({
            id: asString(toolCallWire.id),
            name: asString(toolCallWire.name),
            args,
        });
        try {
            this.#stepQueue.push(new LocalConnectionStep({
                id: toolCall.id,
                stepIndex: 1,
                type: StepType.TOOL_CALL,
                source: StepSource.MODEL,
                target: StepTarget.ENVIRONMENT,
                status: StepStatus.ACTIVE,
                toolCalls: [toolCall],
            }));
            let opContext;
            if (this.#hookRunner) {
                const [result, transformedCall, context] = await this.#hookRunner.dispatchPreToolCall(this.#getTurnContext(), toolCall);
                opContext = context;
                if (!result.allow) {
                    await this.sendToolResults([
                        new ToolResult({
                            id: toolCall.id,
                            name: toolCall.name,
                            error: `Tool execution denied by hook policy: ${result.message || "No reason provided"}`,
                        }),
                    ]);
                    return;
                }
                toolCall.args = transformedCall.args;
            }
            if (!this.#toolRunner) {
                await this.sendToolResults([
                    new ToolResult({
                        id: toolCall.id,
                        name: toolCall.name,
                        error: "No ToolRunner is configured.",
                    }),
                ]);
                return;
            }
            const [result] = await this.#toolRunner.processToolCalls([toolCall]);
            if (!result) {
                return;
            }
            result.id = toolCall.id;
            if (result.error && this.#hookRunner) {
                const [recoveryResult, recoveryValue] = await this.#hookRunner.dispatchOnToolError(opContext ?? new OperationContext(this.#getTurnContext()), result.exception instanceof Error ? result.exception : new Error(result.error));
                if (recoveryResult.allow && recoveryValue !== undefined) {
                    await this.sendToolResults([
                        new ToolResult({
                            id: toolCall.id,
                            name: toolCall.name,
                            result: recoveryValue,
                        }),
                    ]);
                    return;
                }
            }
            else if (!result.error && this.#hookRunner) {
                await this.#hookRunner.dispatchPostToolCall(opContext ?? new OperationContext(this.#getTurnContext()), result);
            }
            await this.sendToolResults([result]);
        }
        catch (error) {
            await this.sendToolResults([
                new ToolResult({
                    id: toolCall.id,
                    name: toolCall.name,
                    error: `Internal SDK error: ${formatErrorForWire(error)}`,
                }),
            ]);
        }
    }
}
export class LocalConnectionStrategy extends ConnectionStrategy {
    #runtimePath;
    #toolRunner;
    #hookRunner;
    #geminiConfig;
    #skillsPaths;
    #systemInstructions;
    #capabilitiesConfig;
    #conversationId;
    #saveDir;
    #workspaces;
    #appDataDir;
    #connection;
    constructor(init = {}) {
        super();
        const geminiConfig = init.geminiConfig ?? init.gemini_config;
        const systemInstructions = init.systemInstructions ?? init.system_instructions;
        this.#runtimePath = init.runtimePath ?? init.runtime_path;
        this.#toolRunner = init.toolRunner ?? init.tool_runner;
        this.#hookRunner = init.hookRunner ?? init.hook_runner;
        if (typeof geminiConfig === "string") {
            this.#geminiConfig = new GeminiConfig();
            this.#geminiConfig.models.default.name = geminiConfig;
        }
        else {
            this.#geminiConfig = geminiConfig;
        }
        this.#skillsPaths = [...(init.skillsPaths ?? init.skills_paths ?? [])];
        if (typeof systemInstructions === "string") {
            this.#systemInstructions = new TemplatedSystemInstructions({
                sections: [new SystemInstructionSection({ content: systemInstructions })],
            });
        }
        else {
            this.#systemInstructions = systemInstructions;
        }
        this.#capabilitiesConfig =
            init.capabilitiesConfig ?? init.capabilities_config ?? new CapabilitiesConfig();
        this.#conversationId = init.conversationId ?? init.conversation_id;
        this.#saveDir = init.saveDir ?? init.save_dir;
        this.#workspaces = (init.workspaces ?? []).map(normalizeWirePath);
        this.#appDataDir = init.appDataDir ?? init.app_data_dir;
    }
    connect() {
        if (!this.#connection) {
            throw new Error("LocalConnectionStrategy has not been started.");
        }
        return this.#connection;
    }
    async start() {
        this.#validateModelAuth();
        const runtimePath = discoverLocalHarness(this.#runtimePath);
        if (!runtimePath) {
            throw new AntigravityConnectionError("Could not find the Antigravity localharness runtime. Set LocalAgentConfig.runtimePath or ANTIGRAVITY_LOCALHARNESS_PATH.");
        }
        const process = spawn(runtimePath, [], { stdio: "pipe" });
        const inputConfig = encodeInputConfig({
            storageDirectory: this.#saveDir ?? "",
            clientInfo: {
                language: "typescript",
                version: "0.1.1-ts.0",
                languageVersion: `${platform()} ${release()}`,
            },
        });
        process.stdin.write(withLengthPrefix(inputConfig));
        const stdout = new BufferedReader(process.stdout);
        const rawLength = await stdout.readExact(4);
        const length = rawLength.readUInt32LE(0);
        const outputConfig = decodeOutputConfig(await stdout.readExact(length));
        const wsUrl = `ws://localhost:${outputConfig.port}/`;
        let ws;
        for (let attempt = 0; attempt < 5; attempt += 1) {
            try {
                ws = await websocketOpen(wsUrl, outputConfig.apiKey);
                break;
            }
            catch (error) {
                if (attempt === 4) {
                    process.kill();
                    throw error;
                }
                await sleep(100 * 2 ** attempt);
            }
        }
        if (!ws) {
            process.kill();
            throw new AntigravityConnectionError(`Failed to connect to ${wsUrl}.`);
        }
        try {
            ws.send(serializeEvent({ config: this.#buildHarnessConfig() }));
        }
        catch (error) {
            ws.close();
            process.kill();
            throw new AntigravityConnectionError(`Failed to initialize conversation at ${wsUrl}.`, {
                cause: error,
            });
        }
        this.#connection = new LocalConnection({
            process,
            ws,
            toolRunner: this.#toolRunner,
            hookRunner: this.#hookRunner,
            conversationId: this.#conversationId,
        });
        await this.#hookRunner?.dispatchSessionStart();
    }
    async stop() {
        await this.#connection?.disconnect();
        this.#connection = undefined;
    }
    #validateModelAuth() {
        const config = this.#geminiConfig;
        const useVertex = config?.vertex ?? false;
        const apiKey = config?.apiKey ?? process.env.GEMINI_API_KEY;
        if (!useVertex && !apiKey) {
            throw new AntigravityValidationError("A Gemini API key is required. Set it via GeminiConfig(apiKey: ...) or the GEMINI_API_KEY environment variable.");
        }
        if (useVertex && !apiKey && !(config?.project && config?.location)) {
            throw new AntigravityValidationError("For Vertex AI, either a GCP project and location, or an API key must be set.");
        }
    }
    #buildHarnessConfig() {
        const cfg = this.#capabilitiesConfig;
        const allTools = BuiltinTools.allTools();
        const activeTools = cfg.enabledTools !== undefined
            ? new Set(cfg.enabledTools.map(String))
            : cfg.disabledTools !== undefined
                ? new Set(allTools.map(String).filter((tool) => !cfg.disabledTools.map(String).includes(tool)))
                : new Set(allTools.map(String));
        const gemini = this.#geminiConfig;
        const defaultModel = gemini?.models.default;
        const systemInstructions = this.#systemInstructions
            ? this.#systemInstructions instanceof CustomSystemInstructions
                ? { custom: { part: [{ text: this.#systemInstructions.text }] } }
                : {
                    appended: {
                        custom_identity: this.#systemInstructions.identity,
                        appended_sections: this.#systemInstructions.sections.map((section) => ({
                            title: section.title,
                            content: section.content,
                        })),
                    },
                }
            : undefined;
        return {
            cascade_id: this.#conversationId ?? "",
            gemini_config: gemini && defaultModel
                ? {
                    api_key: defaultModel.apiKey ?? gemini.apiKey ?? "",
                    model_name: defaultModel.name,
                    thinking_level: defaultModel.generation.thinkingLevel,
                    use_vertex: gemini.vertex,
                    project: gemini.project ?? "",
                    location: gemini.location ?? "",
                }
                : undefined,
            system_instructions: systemInstructions,
            tools: this.#toolProtos(),
            harness_side_tools: {
                subagents: { enabled: cfg.enableSubagents && activeTools.has(BuiltinTools.START_SUBAGENT) },
                find: { enabled: activeTools.has(BuiltinTools.FIND_FILE) },
                user_questions: { enabled: activeTools.has(BuiltinTools.ASK_QUESTION) },
                run_command: { enabled: activeTools.has(BuiltinTools.RUN_COMMAND) },
                file_edit: { enabled: activeTools.has(BuiltinTools.EDIT_FILE) },
                view_file: { enabled: activeTools.has(BuiltinTools.VIEW_FILE) },
                write_to_file: { enabled: activeTools.has(BuiltinTools.CREATE_FILE) },
                grep_search: { enabled: activeTools.has(BuiltinTools.SEARCH_DIR) },
                list_dir: { enabled: activeTools.has(BuiltinTools.LIST_DIR) },
                generate_image: {
                    enabled: activeTools.has(BuiltinTools.GENERATE_IMAGE),
                    model_name: cfg.imageModel,
                },
            },
            compaction_threshold: cfg.compactionThreshold ?? 0,
            workspaces: this.#workspaces.map((directory) => ({
                filesystem_workspace: { directory },
            })),
            skills_paths: this.#skillsPaths,
            finish_tool_schema_json: cfg.finishToolSchemaJson ?? "",
            app_data_dir: this.#appDataDir ?? "",
        };
    }
    #toolProtos() {
        if (!this.#toolRunner) {
            return [];
        }
        const runner = this.#toolRunner;
        return Object.values(runner.tools).map((tool) => callableToToolProto(tool, runner));
    }
}
export function discoverLocalHarness(explicitPath) {
    const pathCandidate = findOnPath(process.platform === "win32" ? "localharness.exe" : "localharness");
    const candidates = [
        explicitPath,
        process.env.ANTIGRAVITY_HARNESS_PATH,
        process.env.ANTIGRAVITY_LOCALHARNESS_PATH,
        join(dirname(fileURLToPath(import.meta.url)), "../../bin/localharness"),
        join(dirname(fileURLToPath(import.meta.url)), "../../../bin/localharness"),
        pathCandidate,
    ].filter((candidate) => Boolean(candidate));
    for (const candidate of candidates) {
        try {
            if (existsSync(candidate)) {
                accessSync(candidate, constants.X_OK);
                return candidate;
            }
        }
        catch {
            continue;
        }
    }
    return undefined;
}
export const discover_local_harness = discoverLocalHarness;
function findOnPath(binaryName) {
    for (const pathEntry of (process.env.PATH ?? "").split(delimiter)) {
        if (!pathEntry) {
            continue;
        }
        const candidate = join(pathEntry, binaryName);
        try {
            if (existsSync(candidate)) {
                accessSync(candidate, constants.X_OK);
                return candidate;
            }
        }
        catch {
            continue;
        }
    }
    return undefined;
}
//# sourceMappingURL=local-connection.js.map