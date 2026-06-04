import * as nodePath from "node:path";

import { Cursor, type ModelParameterDefinition, type SDKModel } from "@cursor/sdk";
import type {
  CursorSettings,
  ModelCapabilities,
  ServerProvider,
  ServerProviderAuth,
  ServerProviderModel,
  ServerProviderState,
  ServerSettingsError,
} from "contracts";
import { Cause, Effect, Equal, Exit, Layer, Option, Result, Stream } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";

import {
  buildServerProvider,
  collectStreamAsString,
  formatModelSlugName,
  isCommandMissingCause,
  providerModelsFromSettings,
  type CommandResult,
} from "../providerSnapshot.ts";
import { makeManagedServerProvider } from "../makeManagedServerProvider.ts";
import { CursorProvider } from "../Services/CursorProvider.ts";
import { ServerSettingsService } from "../../serverSettings.ts";

const PROVIDER = "cursor" as const;
const EMPTY_CAPABILITIES: ModelCapabilities = {
  reasoningEffortLevels: [],
  supportsFastMode: false,
  supportsThinkingToggle: false,
  contextWindowOptions: [],
  promptInjectedEffortLevels: [],
};

const CURSOR_SDK_MODEL_DISCOVERY_TIMEOUT_MS = 15_000;
const CURSOR_CLI_MODEL_DISCOVERY_TIMEOUT_MS = 8_000;
const CURSOR_REFRESH_INTERVAL = "1 hour";

function buildInitialCursorProviderSnapshot(cursorSettings: CursorSettings): ServerProvider {
  const checkedAt = new Date().toISOString();
  const models = getCursorFallbackModels(cursorSettings);

  if (!cursorSettings.enabled) {
    return buildServerProvider({
      provider: PROVIDER,
      enabled: false,
      checkedAt,
      models,
      probe: {
        installed: false,
        version: null,
        status: "warning",
        auth: { status: "unknown" },
        message: "Cursor is disabled in ShioriCode settings.",
      },
    });
  }

  return buildServerProvider({
    provider: PROVIDER,
    enabled: true,
    checkedAt,
    models,
    probe: {
      installed: true,
      version: null,
      status: "warning",
      auth: { status: "unknown" },
      message: "Checking Cursor Agent availability...",
    },
  });
}

interface CursorDiscoveredModel {
  readonly slug: string;
  readonly name: string;
  readonly capabilities: ModelCapabilities;
}

export interface CursorAgentCommand {
  readonly command: string;
  readonly argsPrefix: ReadonlyArray<string>;
  readonly kind: "direct" | "wrapper";
}

export function resolveCursorAgentCommand(
  binaryPath: string | null | undefined,
): CursorAgentCommand {
  const command = binaryPath?.trim() || "agent";
  const basename = nodePath
    .basename(command)
    .toLowerCase()
    .replace(/\.exe$/u, "");
  if (basename === "cursor") {
    return {
      command,
      argsPrefix: ["agent"],
      kind: "wrapper",
    };
  }
  return {
    command,
    argsPrefix: [],
    kind: "direct",
  };
}

export function buildCursorAgentArgs(
  cursorSettings: Pick<CursorSettings, "apiEndpoint" | "binaryPath"> | null | undefined,
  args: ReadonlyArray<string>,
): ReadonlyArray<string> {
  const resolved = resolveCursorAgentCommand(cursorSettings?.binaryPath);
  return [
    ...resolved.argsPrefix,
    ...(cursorSettings?.apiEndpoint ? (["-e", cursorSettings.apiEndpoint] as const) : []),
    ...args,
  ];
}

function normalizeCursorReasoningValue(value: string | null | undefined): string | undefined {
  const normalized = value?.trim().toLowerCase();
  switch (normalized) {
    case "low":
    case "medium":
    case "high":
    case "max":
      return normalized;
    case "xhigh":
    case "extra-high":
    case "extra high":
      return "xhigh";
    default:
      return undefined;
  }
}

function buildCursorDiscoveredModels(
  discoveredModels: ReadonlyArray<CursorDiscoveredModel>,
): ReadonlyArray<ServerProviderModel> {
  const seen = new Set<string>();
  return discoveredModels.flatMap((model) => {
    if (!model.slug || seen.has(model.slug)) {
      return [];
    }
    seen.add(model.slug);
    return [
      {
        slug: model.slug,
        name: formatCursorModelName(model.name || model.slug),
        shortName: formatCursorModelShortName(model.name || model.slug),
        isCustom: false,
        capabilities: model.capabilities,
      } satisfies ServerProviderModel,
    ];
  });
}

function formatCursorModelName(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) return "Cursor Model";
  const normalized = trimmed.toLowerCase();
  if (normalized === "default" || normalized === "auto") {
    return "Cursor (Auto)";
  }
  if (normalized === "composer" || normalized.startsWith("composer-")) {
    return formatModelSlugName(trimmed).replace(/^Composer\b/u, "Cursor Composer");
  }
  return formatModelSlugName(trimmed);
}

function formatCursorModelShortName(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) return "Model";
  const normalized = trimmed.toLowerCase();
  if (normalized === "default" || normalized === "auto") return "Auto";
  return formatModelSlugName(trimmed);
}

function normalizeCursorSdkParameterValue(value: string): string | undefined {
  return normalizeCursorReasoningValue(value) ?? value.trim();
}

function isCursorSdkReasoningParameter(parameterId: string): boolean {
  const normalized = parameterId.trim().toLowerCase();
  return (
    normalized === "effort" ||
    normalized === "reasoning" ||
    normalized.includes("effort") ||
    normalized.includes("reasoning")
  );
}

function isCursorSdkContextParameter(parameterId: string): boolean {
  const normalized = parameterId.trim().toLowerCase();
  return normalized === "context" || normalized.includes("context");
}

function isCursorSdkBooleanParameter(parameter: ModelParameterDefinition | undefined) {
  if (!parameter) return false;
  type CursorParameterValueDefinition = NonNullable<ModelParameterDefinition["values"]>[number];
  const values = new Set(
    parameter.values.map((entry: CursorParameterValueDefinition) =>
      entry.value.trim().toLowerCase(),
    ),
  );
  return values.has("true") && values.has("false");
}

function buildCursorCapabilitiesFromSdkModel(model: SDKModel): ModelCapabilities {
  const parameters = model.parameters ?? [];
  const reasoningParameter = parameters.find((parameter) =>
    isCursorSdkReasoningParameter(parameter.id),
  );
  const contextParameter = parameters.find((parameter) =>
    isCursorSdkContextParameter(parameter.id),
  );
  const fastParameter = parameters.find(
    (parameter) => parameter.id.trim().toLowerCase() === "fast",
  );
  const thinkingParameter = parameters.find(
    (parameter) => parameter.id.trim().toLowerCase() === "thinking",
  );

  return {
    reasoningEffortLevels:
      reasoningParameter?.values.flatMap((entry) => {
        const value = normalizeCursorSdkParameterValue(entry.value);
        return value
          ? [
              {
                value,
                label: entry.displayName ?? entry.value,
              },
            ]
          : [];
      }) ?? [],
    supportsFastMode: isCursorSdkBooleanParameter(fastParameter),
    supportsThinkingToggle: isCursorSdkBooleanParameter(thinkingParameter),
    contextWindowOptions:
      contextParameter?.values.map((entry) => ({
        value: entry.value,
        label: entry.displayName ?? entry.value,
      })) ?? [],
    promptInjectedEffortLevels: [],
  };
}

function cursorSdkVariantSlug(
  model: SDKModel,
  variant: NonNullable<SDKModel["variants"]>[number],
): string {
  if (variant.params.length === 0) return model.id;
  const params = variant.params.map((param) => `${param.id}=${param.value}`).join(",");
  return `${model.id}[${params}]`;
}

export function buildCursorDiscoveredModelsFromSdkModels(
  models: ReadonlyArray<SDKModel>,
): ReadonlyArray<ServerProviderModel> {
  return buildCursorDiscoveredModels(
    models.flatMap((model) => {
      const capabilities = buildCursorCapabilitiesFromSdkModel(model);
      const base = {
        slug: model.id,
        name: model.displayName,
        capabilities,
      };
      const variants = (model.variants ?? []).map((variant) => ({
        slug: cursorSdkVariantSlug(model, variant),
        name: `${formatCursorModelName(model.displayName)} ${variant.displayName}`.trim(),
        capabilities,
      }));
      return [base, ...variants];
    }),
  );
}

export const discoverCursorModelsViaSdk = (): Effect.Effect<
  ReadonlyArray<ServerProviderModel>,
  Error
> =>
  Effect.tryPromise({
    try: () => Cursor.models.list(),
    catch: (cause) => (cause instanceof Error ? cause : new Error(String(cause))),
  }).pipe(Effect.map(buildCursorDiscoveredModelsFromSdkModels));

export function getCursorFallbackModels(
  cursorSettings: Pick<CursorSettings, "customModels">,
): ReadonlyArray<ServerProviderModel> {
  return providerModelsFromSettings([], PROVIDER, cursorSettings.customModels, EMPTY_CAPABILITIES);
}

interface CursorCliModelListEntry {
  readonly slug: string;
  readonly name: string;
}

function readStringField(
  record: Record<string, unknown>,
  keys: ReadonlyArray<string>,
): string | undefined {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "string" && value.trim()) {
      return value.trim();
    }
  }
  return undefined;
}

function collectCursorCliJsonModelEntries(value: unknown): ReadonlyArray<CursorCliModelListEntry> {
  if (Array.isArray(value)) {
    return value.flatMap(collectCursorCliJsonModelEntries);
  }
  if (!value || typeof value !== "object") {
    return [];
  }
  const record = value as Record<string, unknown>;
  const nested = ["models", "availableModels", "data", "items"].flatMap((key) =>
    collectCursorCliJsonModelEntries(record[key]),
  );
  const slug = readStringField(record, ["slug", "id", "model", "value", "name"]);
  if (!slug) {
    return nested;
  }
  const name = readStringField(record, ["name", "label", "displayName", "title"]) ?? slug;
  return [{ slug, name }, ...nested];
}

function parseCursorCliModelLine(line: string): CursorCliModelListEntry | undefined {
  const stripped = stripAnsi(line)
    .trim()
    .replace(/^[-*]\s+/u, "")
    .replace(/^\d+[.)]\s+/u, "")
    .trim();
  if (!stripped) {
    return undefined;
  }
  const lower = stripped.toLowerCase();
  if (lower === "models" || lower === "available models" || lower.startsWith("available models:")) {
    return undefined;
  }
  const withoutDefaultMarker = stripped.replace(/\s+\((?:default|current)\)$/iu, "").trim();
  const [slugPart, namePart] = withoutDefaultMarker.split(/\s{2,}|\t+/u, 2);
  const slug = slugPart?.trim();
  if (!slug || slug.includes(" ")) {
    return undefined;
  }
  return {
    slug,
    name: namePart?.trim() || slug,
  };
}

export function parseCursorCliModelsOutput(
  result: CommandResult,
): ReadonlyArray<ServerProviderModel> {
  const raw = result.stdout.trim() || result.stderr.trim();
  if (!raw) {
    return [];
  }

  let entries: ReadonlyArray<CursorCliModelListEntry> = [];
  if (raw.startsWith("{") || raw.startsWith("[")) {
    try {
      entries = collectCursorCliJsonModelEntries(JSON.parse(raw) as unknown);
    } catch {
      entries = [];
    }
  }

  if (entries.length === 0) {
    entries = raw
      .split(/\r?\n/u)
      .map(parseCursorCliModelLine)
      .filter((entry): entry is CursorCliModelListEntry => entry !== undefined);
  }

  return buildCursorDiscoveredModels(
    entries.map((entry) => ({
      slug: entry.slug,
      name: entry.name,
      capabilities: EMPTY_CAPABILITIES,
    })),
  );
}

interface CursorCliModelDiscoveryResult {
  readonly models: ReadonlyArray<ServerProviderModel>;
  readonly warning?: string;
}

/** Timeout for `agent about` — it's slower than a simple `--version` probe. */
const ABOUT_TIMEOUT_MS = 8_000;

/** Strip ANSI escape sequences so we can parse plain key-value lines. */
function stripAnsi(text: string): string {
  // eslint-disable-next-line no-control-regex
  return text.replace(/\x1b\[[0-9;]*[A-Za-z]|\x1b\].*?\x07/g, "");
}

/**
 * Extract a value from `agent about` key-value output.
 * Lines look like: `CLI Version         2026.03.20-44cb435`
 */
function extractAboutField(plain: string, key: string): string | undefined {
  const regex = new RegExp(`^${key}\\s{2,}(.+)$`, "mi");
  const match = regex.exec(plain);
  return match?.[1]?.trim();
}

export interface CursorAboutResult {
  readonly version: string | null;
  readonly status: Exclude<ServerProviderState, "disabled">;
  readonly auth: ServerProviderAuth;
  readonly message?: string;
}

function joinProviderMessages(...messages: ReadonlyArray<string | undefined>): string | undefined {
  const parts = messages
    .map((message) => message?.trim())
    .filter((message): message is string => Boolean(message));
  return parts.length > 0 ? parts.join(" ") : undefined;
}

export function buildCursorProviderSnapshot(input: {
  readonly checkedAt: string;
  readonly cursorSettings: CursorSettings;
  readonly parsed: CursorAboutResult;
  readonly discoveredModels?: ReadonlyArray<ServerProviderModel>;
  readonly discoveryWarning?: string;
}): ServerProvider {
  const message = joinProviderMessages(input.parsed.message, input.discoveryWarning);
  return buildServerProvider({
    provider: PROVIDER,
    enabled: input.cursorSettings.enabled,
    checkedAt: input.checkedAt,
    models: providerModelsFromSettings(
      input.discoveredModels ?? [],
      PROVIDER,
      input.cursorSettings.customModels,
      EMPTY_CAPABILITIES,
    ),
    probe: {
      installed: true,
      version: input.parsed.version,
      status:
        input.discoveryWarning && input.parsed.status === "ready" ? "warning" : input.parsed.status,
      auth: input.parsed.auth,
      ...(message ? { message } : {}),
    },
  });
}

interface CursorAboutJsonPayload {
  readonly cliVersion?: unknown;
  readonly subscriptionTier?: unknown;
  readonly userEmail?: unknown;
}

function toTitleCaseWords(value: string): string {
  return value
    .split(/[\s_-]+/g)
    .filter((part) => part.length > 0)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1).toLowerCase())
    .join(" ");
}

function cursorSubscriptionLabel(subscriptionType: string | undefined): string | undefined {
  const normalized = subscriptionType?.toLowerCase().replace(/[\s_-]+/g, "");
  if (!normalized) return undefined;

  switch (normalized) {
    case "team":
      return "Team";
    case "pro":
      return "Pro";
    case "free":
      return "Free";
    case "business":
      return "Business";
    case "enterprise":
      return "Enterprise";
    default:
      return toTitleCaseWords(subscriptionType!);
  }
}

function cursorAuthMetadata(
  subscriptionType: string | undefined,
): Pick<ServerProviderAuth, "label" | "type"> | undefined {
  if (!subscriptionType) {
    return undefined;
  }
  const subscriptionLabel = cursorSubscriptionLabel(subscriptionType);
  return {
    type: subscriptionType,
    label: `Cursor ${subscriptionLabel ?? toTitleCaseWords(subscriptionType)} Subscription`,
  };
}

function parseCursorAboutJsonPayload(raw: string): CursorAboutJsonPayload | undefined {
  const trimmed = raw.trim();
  if (!trimmed.startsWith("{")) {
    return undefined;
  }
  try {
    const parsed = JSON.parse(trimmed) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return undefined;
    }
    return parsed as CursorAboutJsonPayload;
  } catch {
    return undefined;
  }
}

function hasOwn(record: object, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(record, key);
}

function isCursorAboutJsonFormatUnsupported(result: CommandResult): boolean {
  const lowerOutput = `${result.stdout}\n${result.stderr}`.toLowerCase();
  return (
    lowerOutput.includes("unknown option '--format'") ||
    lowerOutput.includes("unexpected argument '--format'") ||
    lowerOutput.includes("unrecognized option '--format'") ||
    lowerOutput.includes("unknown argument '--format'")
  );
}

/**
 * Parse the output of `agent about` to extract version and authentication
 * status in a single probe.
 *
 * Example output (logged in):
 * ```
 * About Cursor CLI
 *
 * CLI Version         2026.03.20-44cb435
 * User Email          user@example.com
 * ```
 *
 * Example output (logged out):
 * ```
 * About Cursor CLI
 *
 * CLI Version         2026.03.20-44cb435
 * User Email          Not logged in
 * ```
 */
export function parseCursorAboutOutput(result: CommandResult): CursorAboutResult {
  const jsonPayload = parseCursorAboutJsonPayload(result.stdout);
  if (jsonPayload) {
    const version =
      typeof jsonPayload.cliVersion === "string" ? jsonPayload.cliVersion.trim() : null;
    const hasUserEmailField = hasOwn(jsonPayload, "userEmail");
    const userEmail =
      typeof jsonPayload.userEmail === "string" ? jsonPayload.userEmail.trim() : undefined;
    const subscriptionType =
      typeof jsonPayload.subscriptionTier === "string"
        ? jsonPayload.subscriptionTier.trim()
        : undefined;
    const authMetadata = cursorAuthMetadata(subscriptionType);

    if (hasUserEmailField && jsonPayload.userEmail == null) {
      return {
        version,
        status: "error",
        auth: { status: "unauthenticated" },
        message: "Cursor Agent is not authenticated. Run `agent login` and try again.",
      };
    }

    if (!userEmail) {
      if (result.code === 0) {
        return {
          version,
          status: "ready",
          auth: {
            status: "unknown",
            ...authMetadata,
          },
        };
      }
      return {
        version,
        status: "warning",
        auth: { status: "unknown" },
        message: "Could not verify Cursor Agent authentication status.",
      };
    }

    const lowerEmail = userEmail.toLowerCase();
    if (
      lowerEmail === "not logged in" ||
      lowerEmail.includes("login required") ||
      lowerEmail.includes("authentication required")
    ) {
      return {
        version,
        status: "error",
        auth: { status: "unauthenticated" },
        message: "Cursor Agent is not authenticated. Run `agent login` and try again.",
      };
    }

    return {
      version,
      status: "ready",
      auth: {
        status: "authenticated",
        ...authMetadata,
      },
    };
  }

  const combined = `${result.stdout}\n${result.stderr}`;
  const lowerOutput = combined.toLowerCase();

  // If the command itself isn't recognised, we're on an old CLI version.
  if (
    lowerOutput.includes("unknown command") ||
    lowerOutput.includes("unrecognized command") ||
    lowerOutput.includes("unexpected argument")
  ) {
    return {
      version: null,
      status: "warning",
      auth: { status: "unknown" },
      message: "The `agent about` command is unavailable in this version of the Cursor Agent CLI.",
    };
  }

  const plain = stripAnsi(combined);
  const version = extractAboutField(plain, "CLI Version") ?? null;
  const userEmail = extractAboutField(plain, "User Email");

  // Determine auth from the User Email field.
  if (userEmail === undefined) {
    // Field missing entirely — can't determine auth.
    if (result.code === 0) {
      return { version, status: "ready", auth: { status: "unknown" } };
    }
    return {
      version,
      status: "warning",
      auth: { status: "unknown" },
      message: "Could not verify Cursor Agent authentication status.",
    };
  }

  const lowerEmail = userEmail.toLowerCase();
  if (
    lowerEmail === "not logged in" ||
    lowerEmail.includes("login required") ||
    lowerEmail.includes("authentication required")
  ) {
    return {
      version,
      status: "error",
      auth: { status: "unauthenticated" },
      message: "Cursor Agent is not authenticated. Run `agent login` and try again.",
    };
  }

  // Any non-empty email value means authenticated.
  return { version, status: "ready", auth: { status: "authenticated" } };
}

const runCursorCommandWithSettings = (
  cursorSettings: Pick<CursorSettings, "apiEndpoint" | "binaryPath">,
  args: ReadonlyArray<string>,
) =>
  Effect.gen(function* () {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const agentCommand = resolveCursorAgentCommand(cursorSettings.binaryPath);
    const command = ChildProcess.make(
      agentCommand.command,
      [...buildCursorAgentArgs(cursorSettings, args)],
      {
        shell: process.platform === "win32",
      },
    );

    const child = yield* spawner.spawn(command);
    const [stdout, stderr, exitCode] = yield* Effect.all(
      [
        collectStreamAsString(child.stdout),
        collectStreamAsString(child.stderr),
        child.exitCode.pipe(Effect.map(Number)),
      ],
      { concurrency: "unbounded" },
    );

    return { stdout, stderr, code: exitCode } satisfies CommandResult;
  }).pipe(Effect.scoped);

const runCursorCommand = (args: ReadonlyArray<string>) =>
  Effect.service(ServerSettingsService).pipe(
    Effect.flatMap((service) => service.getSettings),
    Effect.map((settings) => settings.providers.cursor),
    Effect.flatMap((cursorSettings) => runCursorCommandWithSettings(cursorSettings, args)),
  );

const runCursorAboutCommand = Effect.gen(function* () {
  const jsonResult = yield* runCursorCommand(["about", "--format", "json"]);
  if (!isCursorAboutJsonFormatUnsupported(jsonResult)) {
    return jsonResult;
  }
  return yield* runCursorCommand(["about"]);
});

const CURSOR_MODEL_COMMANDS: ReadonlyArray<ReadonlyArray<string>> = [
  ["models", "--format", "json"],
  ["models"],
  ["--list-models"],
];

export const discoverCursorModelsViaCli = (
  cursorSettings: Pick<CursorSettings, "apiEndpoint" | "binaryPath">,
): Effect.Effect<CursorCliModelDiscoveryResult, never, ChildProcessSpawner.ChildProcessSpawner> =>
  Effect.gen(function* () {
    const failures: Array<string> = [];
    for (const args of CURSOR_MODEL_COMMANDS) {
      const exit = yield* Effect.exit(runCursorCommandWithSettings(cursorSettings, args));
      if (Exit.isFailure(exit)) {
        failures.push(`${args.join(" ")} failed: ${Cause.pretty(exit.cause)}`);
        continue;
      }
      const result = exit.value;
      const parsedModels = result.code === 0 ? parseCursorCliModelsOutput(result) : [];
      if (parsedModels.length > 0) {
        return { models: parsedModels };
      }
      failures.push(
        `${args.join(" ")} returned no models${result.code === 0 ? "" : ` (exit ${result.code})`}`,
      );
    }
    return {
      models: [],
      warning:
        failures.length > 0
          ? `Cursor CLI model inventory unavailable. ${failures[0]}`
          : "Cursor CLI model inventory unavailable.",
    };
  });

export const checkCursorProviderStatus = Effect.fn("checkCursorProviderStatus")(
  function* (): Effect.fn.Return<
    ServerProvider,
    ServerSettingsError,
    ChildProcessSpawner.ChildProcessSpawner | ServerSettingsService
  > {
    const cursorSettings = yield* Effect.service(ServerSettingsService).pipe(
      Effect.flatMap((service) => service.getSettings),
      Effect.map((settings) => settings.providers.cursor),
    );
    const checkedAt = new Date().toISOString();
    const fallbackModels = getCursorFallbackModels(cursorSettings);

    if (!cursorSettings.enabled) {
      return buildServerProvider({
        provider: PROVIDER,
        enabled: false,
        checkedAt,
        models: fallbackModels,
        probe: {
          installed: false,
          version: null,
          status: "warning",
          auth: { status: "unknown" },
          message: "Cursor is disabled in ShioriCode settings.",
        },
      });
    }

    // Single `agent about` probe: returns version + auth status in one call.
    const aboutProbe = yield* runCursorAboutCommand.pipe(
      Effect.timeoutOption(ABOUT_TIMEOUT_MS),
      Effect.result,
    );

    if (Result.isFailure(aboutProbe)) {
      const error = aboutProbe.failure;
      return buildServerProvider({
        provider: PROVIDER,
        enabled: cursorSettings.enabled,
        checkedAt,
        models: fallbackModels,
        probe: {
          installed: !isCommandMissingCause(error),
          version: null,
          status: "error",
          auth: { status: "unknown" },
          message: isCommandMissingCause(error)
            ? "Cursor Agent CLI (`agent`) is not installed or not on PATH."
            : `Failed to execute Cursor Agent CLI health check: ${error instanceof Error ? error.message : String(error)}.`,
        },
      });
    }

    if (Option.isNone(aboutProbe.success)) {
      return buildServerProvider({
        provider: PROVIDER,
        enabled: cursorSettings.enabled,
        checkedAt,
        models: fallbackModels,
        probe: {
          installed: true,
          version: null,
          status: "error",
          auth: { status: "unknown" },
          message: "Cursor Agent CLI is installed but timed out while running `agent about`.",
        },
      });
    }

    const parsed = parseCursorAboutOutput(aboutProbe.success.value);
    let discoveredModels = Option.none<ReadonlyArray<ServerProviderModel>>();
    let discoveryWarning: string | undefined;
    if (parsed.auth.status !== "unauthenticated") {
      const sdkDiscoveryExit = yield* Effect.exit(
        discoverCursorModelsViaSdk().pipe(
          Effect.timeoutOption(CURSOR_SDK_MODEL_DISCOVERY_TIMEOUT_MS),
        ),
      );
      if (Exit.isSuccess(sdkDiscoveryExit) && Option.isSome(sdkDiscoveryExit.value)) {
        if (sdkDiscoveryExit.value.value.length > 0) {
          discoveredModels = sdkDiscoveryExit.value;
        } else {
          discoveryWarning = "Cursor SDK model discovery returned no built-in models.";
        }
      } else {
        if (Exit.isFailure(sdkDiscoveryExit)) {
          yield* Effect.logWarning("Cursor SDK model discovery failed", {
            cause: Cause.pretty(sdkDiscoveryExit.cause),
          });
        } else {
          discoveryWarning = `Cursor SDK model discovery timed out after ${CURSOR_SDK_MODEL_DISCOVERY_TIMEOUT_MS}ms.`;
        }

        const cliDiscoveryExit = yield* Effect.exit(
          discoverCursorModelsViaCli(cursorSettings).pipe(
            Effect.timeoutOption(CURSOR_CLI_MODEL_DISCOVERY_TIMEOUT_MS),
          ),
        );
        if (Exit.isSuccess(cliDiscoveryExit) && Option.isSome(cliDiscoveryExit.value)) {
          if (cliDiscoveryExit.value.value.models.length > 0) {
            discoveredModels = Option.some(cliDiscoveryExit.value.value.models);
          }
          if (cliDiscoveryExit.value.value.warning) {
            yield* Effect.logWarning(cliDiscoveryExit.value.value.warning);
          }
        } else if (Exit.isFailure(cliDiscoveryExit)) {
          yield* Effect.logWarning("Cursor CLI model inventory failed", {
            cause: Cause.pretty(cliDiscoveryExit.cause),
          });
          discoveryWarning =
            discoveryWarning ??
            "Cursor SDK and CLI model discovery failed. Check server logs for details.";
        } else {
          discoveryWarning =
            discoveryWarning ??
            `Cursor CLI model inventory timed out after ${CURSOR_CLI_MODEL_DISCOVERY_TIMEOUT_MS}ms.`;
        }
        if (Option.isSome(discoveredModels) && discoveredModels.value.length > 0) {
          discoveryWarning =
            discoveryWarning === undefined
              ? undefined
              : `${discoveryWarning} Using Cursor CLI model inventory fallback.`;
        }
        if (Option.isNone(discoveredModels)) {
          discoveryWarning =
            discoveryWarning ??
            "Cursor SDK model discovery returned no built-in models and no CLI fallback was available.";
        }
      }
    }
    return buildCursorProviderSnapshot({
      checkedAt,
      cursorSettings,
      parsed,
      discoveredModels: Option.getOrElse(
        Option.filter(discoveredModels, (models) => models.length > 0),
        () => [] as const,
      ),
      ...(discoveryWarning ? { discoveryWarning } : {}),
    });
  },
);

export const CursorProviderLive = Layer.effect(
  CursorProvider,
  Effect.gen(function* () {
    const serverSettings = yield* ServerSettingsService;
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;

    const checkProvider = checkCursorProviderStatus().pipe(
      Effect.provideService(ServerSettingsService, serverSettings),
      Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
    );

    return yield* makeManagedServerProvider<CursorSettings>({
      getSettings: serverSettings.getSettings.pipe(
        Effect.map((settings) => settings.providers.cursor),
        Effect.orDie,
      ),
      streamSettings: serverSettings.streamChanges.pipe(
        Stream.map((settings) => settings.providers.cursor),
      ),
      haveSettingsChanged: (previous, next) => !Equal.equals(previous, next),
      buildInitialSnapshot: buildInitialCursorProviderSnapshot,
      checkProvider,
      refreshInterval: CURSOR_REFRESH_INTERVAL,
    });
  }),
);
