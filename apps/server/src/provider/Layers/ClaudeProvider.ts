import type {
  ClaudeSettings,
  ModelCapabilities,
  ServerProvider,
  ServerProviderModel,
  ServerProviderAuth,
  ServerProviderState,
} from "contracts";
import { Cache, Duration, Effect, Equal, Layer, Option, Result, Schema, Stream } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";
import { decodeJsonResult } from "shared/schemaJson";
import {
  query as claudeQuery,
  type ModelInfo as ClaudeSdkModelInfo,
} from "@anthropic-ai/claude-agent-sdk";

import {
  buildPendingServerProvider,
  buildServerProvider,
  DEFAULT_TIMEOUT_MS,
  detailFromResult,
  extractAuthBoolean,
  isCommandMissingCause,
  parseGenericCliVersion,
  providerModelsFromSettings,
  spawnAndCollect,
  type CommandResult,
} from "../providerSnapshot";
import { makeManagedServerProvider } from "../makeManagedServerProvider";
import { ClaudeProvider } from "../Services/ClaudeProvider";
import { ServerSettingsService } from "../../serverSettings";
import { ServerSettingsError } from "contracts";

const PROVIDER = "claudeAgent" as const;
const OPUS_4_8_CAPABILITIES: ModelCapabilities = {
  reasoningEffortLevels: [
    { value: "low", label: "Low" },
    { value: "medium", label: "Medium" },
    { value: "high", label: "High", isDefault: true },
    { value: "max", label: "Max" },
    { value: "ultrathink", label: "Ultrathink" },
  ],
  supportsFastMode: true,
  supportsThinkingToggle: false,
  contextWindowOptions: [
    { value: "200k", label: "200k", isDefault: true },
    { value: "1m", label: "1M" },
  ],
  promptInjectedEffortLevels: ["ultrathink"],
};

const OPUS_4_6_CAPABILITIES: ModelCapabilities = {
  ...OPUS_4_8_CAPABILITIES,
  supportsFastMode: true,
};

const SONNET_4_6_CAPABILITIES: ModelCapabilities = {
  reasoningEffortLevels: [
    { value: "low", label: "Low" },
    { value: "medium", label: "Medium" },
    { value: "high", label: "High", isDefault: true },
    { value: "ultrathink", label: "Ultrathink" },
  ],
  supportsFastMode: false,
  supportsThinkingToggle: false,
  contextWindowOptions: [
    { value: "200k", label: "200k", isDefault: true },
    { value: "1m", label: "1M" },
  ],
  promptInjectedEffortLevels: ["ultrathink"],
};

const HAIKU_4_5_CAPABILITIES: ModelCapabilities = {
  reasoningEffortLevels: [],
  supportsFastMode: false,
  supportsThinkingToggle: true,
  contextWindowOptions: [],
  promptInjectedEffortLevels: [],
};

const VISIBLE_BUILT_IN_MODELS: ReadonlyArray<ServerProviderModel> = [
  {
    slug: "claude-opus-4-8",
    name: "Opus 4.8",
    isCustom: false,
    capabilities: OPUS_4_8_CAPABILITIES,
  },
  {
    slug: "claude-sonnet-4-6",
    name: "Sonnet 4.6",
    isCustom: false,
    capabilities: SONNET_4_6_CAPABILITIES,
  },
  {
    slug: "claude-haiku-4-5",
    name: "Haiku 4.5",
    isCustom: false,
    capabilities: HAIKU_4_5_CAPABILITIES,
  },
];

const BUILT_IN_CAPABILITIES_BY_MODEL = new Map<string, ModelCapabilities>([
  ["claude-opus-4-8", OPUS_4_8_CAPABILITIES],
  ["claude-sonnet-4-6", SONNET_4_6_CAPABILITIES],
  ["claude-haiku-4-5", HAIKU_4_5_CAPABILITIES],
  ["claude-opus-4-7", OPUS_4_8_CAPABILITIES],
  ["claude-opus-4-6", OPUS_4_6_CAPABILITIES],
]);

export function getClaudeModelCapabilities(model: string | null | undefined): ModelCapabilities {
  const slug = model?.trim();
  return (
    (slug ? BUILT_IN_CAPABILITIES_BY_MODEL.get(slug) : undefined) ?? {
      reasoningEffortLevels: [],
      supportsFastMode: false,
      supportsThinkingToggle: false,
      contextWindowOptions: [],
      promptInjectedEffortLevels: [],
    }
  );
}

function buildPendingClaudeProviderStatus(claudeSettings: ClaudeSettings): ServerProvider {
  const checkedAt = new Date().toISOString();
  const models = providerModelsFromSettings(
    VISIBLE_BUILT_IN_MODELS,
    PROVIDER,
    claudeSettings.customModels,
  );

  if (!claudeSettings.enabled) {
    return buildPendingServerProvider({
      provider: PROVIDER,
      enabled: false,
      installed: false,
      checkedAt,
      models,
      message: "Claude is disabled in ShioriCode settings.",
    });
  }

  return buildPendingServerProvider({
    provider: PROVIDER,
    enabled: true,
    checkedAt,
    models,
    message: "Checking Claude CLI availability...",
  });
}

export function parseClaudeAuthStatusFromOutput(result: CommandResult): {
  readonly status: Exclude<ServerProviderState, "disabled">;
  readonly auth: Pick<ServerProviderAuth, "status">;
  readonly message?: string;
} {
  const lowerOutput = `${result.stdout}\n${result.stderr}`.toLowerCase();

  if (
    lowerOutput.includes("unknown command") ||
    lowerOutput.includes("unrecognized command") ||
    lowerOutput.includes("unexpected argument")
  ) {
    return {
      status: "warning",
      auth: { status: "unknown" },
      message:
        "Claude Agent authentication status command is unavailable in this version of Claude.",
    };
  }

  if (
    lowerOutput.includes("not logged in") ||
    lowerOutput.includes("login required") ||
    lowerOutput.includes("authentication required") ||
    lowerOutput.includes("run `claude login`") ||
    lowerOutput.includes("run claude login")
  ) {
    return {
      status: "error",
      auth: { status: "unauthenticated" },
      message: "Claude is not authenticated. Run `claude auth login` and try again.",
    };
  }

  const parsedAuth = (() => {
    const trimmed = result.stdout.trim();
    if (!trimmed || (!trimmed.startsWith("{") && !trimmed.startsWith("["))) {
      return { attemptedJsonParse: false as const, auth: undefined as boolean | undefined };
    }
    try {
      return {
        attemptedJsonParse: true as const,
        auth: extractAuthBoolean(JSON.parse(trimmed)),
      };
    } catch {
      return { attemptedJsonParse: false as const, auth: undefined as boolean | undefined };
    }
  })();

  if (parsedAuth.auth === true) {
    return { status: "ready", auth: { status: "authenticated" } };
  }
  if (parsedAuth.auth === false) {
    return {
      status: "error",
      auth: { status: "unauthenticated" },
      message: "Claude is not authenticated. Run `claude auth login` and try again.",
    };
  }
  if (parsedAuth.attemptedJsonParse) {
    return {
      status: "warning",
      auth: { status: "unknown" },
      message:
        "Could not verify Claude authentication status from JSON output (missing auth marker).",
    };
  }
  if (result.code === 0) {
    return {
      status: "warning",
      auth: { status: "unknown" },
      message:
        "Could not verify Claude authentication status because JSON output did not include a recognized auth marker.",
    };
  }

  const detail = detailFromResult(result);
  return {
    status: "warning",
    auth: { status: "unknown" },
    message: detail
      ? `Could not verify Claude authentication status. ${detail}`
      : "Could not verify Claude authentication status.",
  };
}

// ── Subscription type detection ─────────────────────────────────────
//
// The SDK probe returns typed `AccountInfo.subscriptionType` directly.
// This walker is a best-effort fallback for the `claude auth status`
// JSON output whose shape is not guaranteed.

/** Keys that directly hold a subscription/plan identifier. */
const SUBSCRIPTION_TYPE_KEYS = [
  "subscriptionType",
  "subscription_type",
  "plan",
  "tier",
  "planType",
  "plan_type",
] as const;

/** Keys whose value may be a nested object containing subscription info. */
const SUBSCRIPTION_CONTAINER_KEYS = ["account", "subscription", "user", "billing"] as const;
const AUTH_METHOD_KEYS = ["authMethod", "auth_method"] as const;
const AUTH_METHOD_CONTAINER_KEYS = ["auth", "account", "session"] as const;

/** Lift an unknown value into `Option<string>` if it is a non-empty string. */
const asNonEmptyString = (v: unknown): Option.Option<string> =>
  typeof v === "string" && v.length > 0 ? Option.some(v) : Option.none();

/** Lift an unknown value into `Option<Record>` if it is a plain object. */
const asRecord = (v: unknown): Option.Option<Record<string, unknown>> =>
  typeof v === "object" && v !== null && !globalThis.Array.isArray(v)
    ? Option.some(v as Record<string, unknown>)
    : Option.none();

/**
 * Walk an unknown parsed JSON value looking for a subscription/plan
 * identifier, returning the first match as an `Option`.
 */
function findSubscriptionType(value: unknown): Option.Option<string> {
  if (globalThis.Array.isArray(value)) {
    return Option.firstSomeOf(value.map(findSubscriptionType));
  }

  return asRecord(value).pipe(
    Option.flatMap((record) => {
      const direct = Option.firstSomeOf(
        SUBSCRIPTION_TYPE_KEYS.map((key) => asNonEmptyString(record[key])),
      );
      if (Option.isSome(direct)) return direct;

      return Option.firstSomeOf(
        SUBSCRIPTION_CONTAINER_KEYS.map((key) =>
          asRecord(record[key]).pipe(Option.flatMap(findSubscriptionType)),
        ),
      );
    }),
  );
}

function findAuthMethod(value: unknown): Option.Option<string> {
  if (globalThis.Array.isArray(value)) {
    return Option.firstSomeOf(value.map(findAuthMethod));
  }

  return asRecord(value).pipe(
    Option.flatMap((record) => {
      const direct = Option.firstSomeOf(
        AUTH_METHOD_KEYS.map((key) => asNonEmptyString(record[key])),
      );
      if (Option.isSome(direct)) return direct;

      return Option.firstSomeOf(
        AUTH_METHOD_CONTAINER_KEYS.map((key) =>
          asRecord(record[key]).pipe(Option.flatMap(findAuthMethod)),
        ),
      );
    }),
  );
}

/**
 * Try to extract a subscription type from the `claude auth status` JSON
 * output. This is a zero-cost operation on data we already have.
 */
const decodeUnknownJson = decodeJsonResult(Schema.Unknown);

function extractSubscriptionTypeFromOutput(result: CommandResult): string | undefined {
  const parsed = decodeUnknownJson(result.stdout.trim());
  if (Result.isFailure(parsed)) return undefined;
  return Option.getOrUndefined(findSubscriptionType(parsed.success));
}

function extractClaudeAuthMethodFromOutput(result: CommandResult): string | undefined {
  const parsed = decodeUnknownJson(result.stdout.trim());
  if (Result.isFailure(parsed)) return undefined;
  return Option.getOrUndefined(findAuthMethod(parsed.success));
}

// ── Dynamic model capability adjustment ─────────────────────────────

/** Subscription types where the 1M context window is included in the plan. */
const PREMIUM_SUBSCRIPTION_TYPES = new Set([
  "max",
  "maxplan",
  "max5",
  "max20",
  "enterprise",
  "team",
]);

function toTitleCaseWords(value: string): string {
  return value
    .split(/[\s_-]+/g)
    .filter(Boolean)
    .map((part) => part[0]!.toUpperCase() + part.slice(1).toLowerCase())
    .join(" ");
}

function claudeSubscriptionLabel(subscriptionType: string | undefined): string | undefined {
  const normalized = subscriptionType?.toLowerCase().replace(/[\s_-]+/g, "");
  if (!normalized) return undefined;

  switch (normalized) {
    case "max":
    case "maxplan":
    case "max5":
    case "max20":
      return "Max";
    case "enterprise":
      return "Enterprise";
    case "team":
      return "Team";
    case "pro":
      return "Pro";
    case "free":
      return "Free";
    default:
      return toTitleCaseWords(subscriptionType!);
  }
}

function normalizeClaudeAuthMethod(authMethod: string | undefined): string | undefined {
  const normalized = authMethod?.toLowerCase().replace(/[\s_-]+/g, "");
  if (!normalized) return undefined;
  if (normalized === "apikey") return "apiKey";
  return undefined;
}

function claudeAuthMetadata(input: {
  readonly subscriptionType: string | undefined;
  readonly authMethod: string | undefined;
}): { readonly type: string; readonly label: string } | undefined {
  if (normalizeClaudeAuthMethod(input.authMethod) === "apiKey") {
    return {
      type: "apiKey",
      label: "Claude API Key",
    };
  }

  if (input.subscriptionType) {
    const subscriptionLabel = claudeSubscriptionLabel(input.subscriptionType);
    return {
      type: input.subscriptionType,
      label: `Claude ${subscriptionLabel ?? toTitleCaseWords(input.subscriptionType)} Subscription`,
    };
  }

  return undefined;
}

/**
 * Adjust the built-in model list based on the user's detected subscription.
 *
 * - Premium tiers (Max, Enterprise, Team): 1M context becomes the default.
 * - Other tiers (Pro, free, unknown): 200k context stays the default;
 *   1M remains available as a manual option so users can still enable it.
 */
export function adjustModelsForSubscription(
  baseModels: ReadonlyArray<ServerProviderModel>,
  subscriptionType: string | undefined,
): ReadonlyArray<ServerProviderModel> {
  const normalized = subscriptionType?.toLowerCase().replace(/[\s_-]+/g, "");
  if (!normalized || !PREMIUM_SUBSCRIPTION_TYPES.has(normalized)) {
    return baseModels;
  }

  // Flip 1M to be the default for premium users
  return baseModels.map((model) => {
    const caps = model.capabilities;
    if (!caps || caps.contextWindowOptions.length === 0) return model;

    return {
      ...model,
      capabilities: {
        ...caps,
        contextWindowOptions: caps.contextWindowOptions.map((opt) =>
          opt.value === "1m"
            ? { value: opt.value, label: opt.label, isDefault: true as const }
            : { value: opt.value, label: opt.label },
        ),
      },
    };
  });
}

// ── SDK capability probe ────────────────────────────────────────────

const CAPABILITIES_PROBE_TIMEOUT_MS = 8_000;

interface ClaudeCapabilitiesProbeResult {
  readonly subscriptionType: string | undefined;
  readonly models: ReadonlyArray<ClaudeSdkModelInfo>;
}

function effortLevelLabel(value: string): string {
  return value[0] ? value[0].toUpperCase() + value.slice(1) : value;
}

function buildSdkModelCapabilities(
  model: ClaudeSdkModelInfo,
  builtInCapabilities: ModelCapabilities | null,
): ModelCapabilities {
  const sdkEffortLevels =
    model.supportedEffortLevels?.map((value) => ({
      value,
      label: effortLevelLabel(value),
      ...(value === "high" ? { isDefault: true as const } : {}),
    })) ?? [];
  const reasoningEffortLevels =
    sdkEffortLevels.length > 0
      ? sdkEffortLevels
      : model.supportsEffort === true
        ? [
            { value: "low", label: "Low" },
            { value: "medium", label: "Medium" },
            { value: "high", label: "High", isDefault: true as const },
            { value: "max", label: "Max" },
          ]
        : [];

  const builtInPromptInjectedEfforts = builtInCapabilities?.promptInjectedEffortLevels ?? [];
  const mergedEffortLevels = [
    ...reasoningEffortLevels,
    ...builtInPromptInjectedEfforts
      .filter((value) => !reasoningEffortLevels.some((level) => level.value === value))
      .map((value) => ({ value, label: effortLevelLabel(value) })),
  ];

  return {
    reasoningEffortLevels: mergedEffortLevels,
    supportsFastMode: model.supportsFastMode ?? builtInCapabilities?.supportsFastMode ?? false,
    supportsThinkingToggle:
      model.supportsAdaptiveThinking ?? builtInCapabilities?.supportsThinkingToggle ?? false,
    contextWindowOptions: builtInCapabilities?.contextWindowOptions ?? [],
    promptInjectedEffortLevels: builtInPromptInjectedEfforts,
  };
}

function resolveClaudeSdkModelSlug(model: ClaudeSdkModelInfo): string | null {
  const value = model.value.trim().toLowerCase();
  const displayName = model.displayName.trim().toLowerCase();

  if (!value || value === "default" || displayName.startsWith("default")) {
    return null;
  }

  if (
    value === "opus" ||
    value === "opus-4-8" ||
    value === "opus-4.8" ||
    value === "claude-opus-4-8"
  ) {
    return "claude-opus-4-8";
  }

  if (
    value === "sonnet" ||
    value === "sonnet-4-6" ||
    value === "sonnet-4.6" ||
    value === "claude-sonnet-4-6"
  ) {
    return "claude-sonnet-4-6";
  }

  if (
    value === "haiku" ||
    value === "haiku-4-5" ||
    value === "haiku-4.5" ||
    value === "claude-haiku-4-5"
  ) {
    return "claude-haiku-4-5";
  }

  return null;
}

function modelsFromClaudeSdk(
  models: ReadonlyArray<ClaudeSdkModelInfo> | null | undefined,
): ReadonlyArray<ServerProviderModel> | null {
  if (!models || models.length === 0) {
    return null;
  }

  const sdkModelsBySlug = new Map<string, ClaudeSdkModelInfo>();

  for (const model of models) {
    const slug = resolveClaudeSdkModelSlug(model);
    if (!slug || sdkModelsBySlug.has(slug)) {
      continue;
    }

    sdkModelsBySlug.set(slug, model);
  }

  if (sdkModelsBySlug.size === 0) {
    return null;
  }

  return VISIBLE_BUILT_IN_MODELS.map((builtIn) => {
    const sdkModel = sdkModelsBySlug.get(builtIn.slug);
    if (!sdkModel) {
      return builtIn;
    }

    return {
      ...builtIn,
      capabilities: buildSdkModelCapabilities(sdkModel, builtIn.capabilities),
    };
  });
}

/**
 * Probe account information by spawning a lightweight Claude Agent SDK
 * session and reading the initialization result.
 *
 * The prompt is never sent to the Anthropic API — we abort immediately
 * after the local initialization phase completes. This gives us the
 * user's subscription type without incurring any token cost.
 *
 * This is used as a fallback when `claude auth status` does not include
 * subscription type information.
 */
const probeClaudeCapabilities = (binaryPath: string) => {
  const abort = new AbortController();
  return Effect.tryPromise(async () => {
    const q = claudeQuery({
      prompt: ".",
      options: {
        persistSession: false,
        pathToClaudeCodeExecutable: binaryPath,
        abortController: abort,
        maxTurns: 0,
        settingSources: [],
        allowedTools: [],
        stderr: () => {},
      },
    });
    const init = await q.initializationResult();
    return {
      subscriptionType: init.account?.subscriptionType,
      models: init.models,
    } satisfies ClaudeCapabilitiesProbeResult;
  }).pipe(
    Effect.ensuring(
      Effect.sync(() => {
        if (!abort.signal.aborted) abort.abort();
      }),
    ),
    Effect.timeoutOption(CAPABILITIES_PROBE_TIMEOUT_MS),
    Effect.result,
    Effect.map((result) => {
      if (Result.isFailure(result)) return undefined;
      return Option.isSome(result.success) ? result.success.value : undefined;
    }),
  );
};

const runClaudeCommand = Effect.fn("runClaudeCommand")(function* (args: ReadonlyArray<string>) {
  const claudeSettings = yield* Effect.service(ServerSettingsService).pipe(
    Effect.flatMap((service) => service.getSettings),
    Effect.map((settings) => settings.providers.claudeAgent),
  );
  const command = ChildProcess.make(claudeSettings.binaryPath, [...args], {
    shell: process.platform === "win32",
  });
  return yield* spawnAndCollect(claudeSettings.binaryPath, command);
});

export const checkClaudeProviderStatus = Effect.fn("checkClaudeProviderStatus")(function* (
  resolveCapabilities?: (
    binaryPath: string,
    authContext: string | undefined,
  ) => Effect.Effect<ClaudeCapabilitiesProbeResult | undefined>,
): Effect.fn.Return<
  ServerProvider,
  ServerSettingsError,
  ChildProcessSpawner.ChildProcessSpawner | ServerSettingsService
> {
  const claudeSettings = yield* Effect.service(ServerSettingsService).pipe(
    Effect.flatMap((service) => service.getSettings),
    Effect.map((settings) => settings.providers.claudeAgent),
  );
  const checkedAt = new Date().toISOString();
  const fallbackModels = providerModelsFromSettings(
    VISIBLE_BUILT_IN_MODELS,
    PROVIDER,
    claudeSettings.customModels,
  );

  if (!claudeSettings.enabled) {
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
        message: "Claude is disabled in ShioriCode settings.",
      },
    });
  }

  const versionProbe = yield* runClaudeCommand(["--version"]).pipe(
    Effect.timeoutOption(DEFAULT_TIMEOUT_MS),
    Effect.result,
  );

  if (Result.isFailure(versionProbe)) {
    const error = versionProbe.failure;
    return buildServerProvider({
      provider: PROVIDER,
      enabled: claudeSettings.enabled,
      checkedAt,
      models: fallbackModels,
      probe: {
        installed: !isCommandMissingCause(error),
        version: null,
        status: "error",
        auth: { status: "unknown" },
        message: isCommandMissingCause(error)
          ? "Claude Agent CLI (`claude`) is not installed or not on PATH."
          : `Failed to execute Claude Agent CLI health check: ${error instanceof Error ? error.message : String(error)}.`,
      },
    });
  }

  if (Option.isNone(versionProbe.success)) {
    return buildServerProvider({
      provider: PROVIDER,
      enabled: claudeSettings.enabled,
      checkedAt,
      models: fallbackModels,
      probe: {
        installed: true,
        version: null,
        status: "error",
        auth: { status: "unknown" },
        message:
          "Claude Agent CLI is installed but failed to run. Timed out while running command.",
      },
    });
  }

  const version = versionProbe.success.value;
  const parsedVersion = parseGenericCliVersion(`${version.stdout}\n${version.stderr}`);
  if (version.code !== 0) {
    const detail = detailFromResult(version);
    return buildServerProvider({
      provider: PROVIDER,
      enabled: claudeSettings.enabled,
      checkedAt,
      models: fallbackModels,
      probe: {
        installed: true,
        version: parsedVersion,
        status: "error",
        auth: { status: "unknown" },
        message: detail
          ? `Claude Agent CLI is installed but failed to run. ${detail}`
          : "Claude Agent CLI is installed but failed to run.",
      },
    });
  }

  // ── Auth check + subscription detection ────────────────────────────

  const authProbe = yield* runClaudeCommand(["auth", "status", "--json"]).pipe(
    Effect.timeoutOption(DEFAULT_TIMEOUT_MS),
    Effect.result,
  );

  // Determine subscription/model metadata from multiple sources (cheapest first):
  // 1. `claude auth status` JSON output (may or may not contain it)
  // 2. Cached SDK probe (spawns a Claude process on miss, reads
  //    `initializationResult()` for account/model metadata, then aborts
  //    immediately — no API tokens are consumed)

  let subscriptionType: string | undefined;
  let authMethod: string | undefined;
  let sdkModels: ReadonlyArray<ClaudeSdkModelInfo> | undefined;

  if (Result.isSuccess(authProbe) && Option.isSome(authProbe.success)) {
    subscriptionType = extractSubscriptionTypeFromOutput(authProbe.success.value);
    authMethod = extractClaudeAuthMethodFromOutput(authProbe.success.value);
  }

  if (resolveCapabilities) {
    const authContext =
      Result.isSuccess(authProbe) && Option.isSome(authProbe.success)
        ? `${extractClaudeAuthMethodFromOutput(authProbe.success.value) ?? "unknown"}:${authProbe.success.value.stdout.trim()}`
        : undefined;
    const capabilities = yield* resolveCapabilities(claudeSettings.binaryPath, authContext);
    subscriptionType = subscriptionType ?? capabilities?.subscriptionType;
    sdkModels = capabilities?.models;
  }

  const sdkBuiltInModels = modelsFromClaudeSdk(sdkModels);
  const models =
    sdkBuiltInModels !== null
      ? providerModelsFromSettings(sdkBuiltInModels, PROVIDER, claudeSettings.customModels)
      : fallbackModels;
  const resolvedModels = adjustModelsForSubscription(models, subscriptionType);

  // ── Handle auth results (same logic as before, adjusted models) ──

  if (Result.isFailure(authProbe)) {
    const error = authProbe.failure;
    return buildServerProvider({
      provider: PROVIDER,
      enabled: claudeSettings.enabled,
      checkedAt,
      models: resolvedModels,
      probe: {
        installed: true,
        version: parsedVersion,
        status: "warning",
        auth: { status: "unknown" },
        message:
          error instanceof Error
            ? `Could not verify Claude authentication status: ${error.message}.`
            : "Could not verify Claude authentication status.",
      },
    });
  }

  if (Option.isNone(authProbe.success)) {
    return buildServerProvider({
      provider: PROVIDER,
      enabled: claudeSettings.enabled,
      checkedAt,
      models: resolvedModels,
      probe: {
        installed: true,
        version: parsedVersion,
        status: "warning",
        auth: { status: "unknown" },
        message: "Could not verify Claude authentication status. Timed out while running command.",
      },
    });
  }

  const parsed = parseClaudeAuthStatusFromOutput(authProbe.success.value);
  const authMetadata = claudeAuthMetadata({ subscriptionType, authMethod });
  return buildServerProvider({
    provider: PROVIDER,
    enabled: claudeSettings.enabled,
    checkedAt,
    models: resolvedModels,
    probe: {
      installed: true,
      version: parsedVersion,
      status: parsed.status,
      auth: {
        ...parsed.auth,
        ...(authMetadata ? authMetadata : {}),
      },
      ...(parsed.message ? { message: parsed.message } : {}),
    },
  });
});

export const ClaudeProviderLive = Layer.effect(
  ClaudeProvider,
  Effect.gen(function* () {
    const serverSettings = yield* ServerSettingsService;
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;

    const subscriptionProbeCache = yield* Cache.make({
      capacity: 1,
      timeToLive: Duration.minutes(5),
      lookup: (cacheKey: string) => {
        const [binaryPath] = cacheKey.split("\u0000", 1);
        return probeClaudeCapabilities(binaryPath ?? cacheKey);
      },
    });

    const checkProvider = checkClaudeProviderStatus((binaryPath, authContext) =>
      Cache.get(subscriptionProbeCache, `${binaryPath}\u0000${authContext ?? "unknown"}`),
    ).pipe(
      Effect.provideService(ServerSettingsService, serverSettings),
      Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
    );

    return yield* makeManagedServerProvider<ClaudeSettings>({
      getSettings: serverSettings.getSettings.pipe(
        Effect.map((settings) => settings.providers.claudeAgent),
        Effect.orDie,
      ),
      streamSettings: serverSettings.streamChanges.pipe(
        Stream.map((settings) => settings.providers.claudeAgent),
      ),
      haveSettingsChanged: (previous, next) => !Equal.equals(previous, next),
      checkProvider,
      buildInitialSnapshot: buildPendingClaudeProviderStatus,
    });
  }),
);
