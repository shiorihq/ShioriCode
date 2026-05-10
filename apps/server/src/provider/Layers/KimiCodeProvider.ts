import type {
  KimiCodeSettings,
  ModelCapabilities,
  ServerProvider,
  ServerProviderModel,
} from "contracts";
import { Effect, Layer, Option, Result, Stream } from "effect";
import { ChildProcessSpawner, ChildProcess } from "effect/unstable/process";
import { isLoggedIn, parseConfig } from "@moonshot-ai/kimi-agent-sdk";

import {
  buildPendingServerProvider,
  buildServerProvider,
  DEFAULT_TIMEOUT_MS,
  isCommandMissingCause,
  parseGenericCliVersion,
  providerModelsFromSettings,
  spawnAndCollect,
} from "../providerSnapshot";
import { makeManagedServerProvider } from "../makeManagedServerProvider";
import { KimiCodeProvider } from "../Services/KimiCodeProvider";
import { ServerSettingsService } from "../../serverSettings";

const PROVIDER = "kimiCode" as const;
const MIN_SUPPORTED_KIMI_WIRE_VERSION = "1.7.0";
const BUILT_IN_MODELS: ReadonlyArray<ServerProviderModel> = [
  {
    slug: "kimi-code/kimi-for-coding",
    name: "Kimi K2.6",
    isCustom: false,
    multiModal: false,
    capabilities: {
      reasoningEffortLevels: [],
      supportsFastMode: false,
      supportsThinkingToggle: true,
      contextWindowOptions: [],
      promptInjectedEffortLevels: [],
    } satisfies ModelCapabilities,
  },
];

function buildPendingKimiCodeProviderStatus(settings: KimiCodeSettings): ServerProvider {
  const checkedAt = new Date().toISOString();
  const models = providerModelsFromSettings(BUILT_IN_MODELS, PROVIDER, settings.customModels);

  if (!settings.enabled) {
    return buildPendingServerProvider({
      provider: PROVIDER,
      enabled: false,
      installed: false,
      checkedAt,
      models,
      message: "Kimi Code is disabled in ShioriCode settings.",
    });
  }

  return buildPendingServerProvider({
    provider: PROVIDER,
    enabled: true,
    checkedAt,
    models,
    message: "Checking Kimi Code CLI availability...",
  });
}

function modelsFromConfig(_settings: KimiCodeSettings): ReadonlyArray<ServerProviderModel> {
  // Keep Kimi pinned to a single model, but use the configured model key that
  // the local Kimi CLI actually expects.
  const shareDir = _settings.shareDir.trim() || undefined;
  const config = parseConfig(shareDir);
  const selectedModel = config.models.find(
    (model) =>
      model.name.toLowerCase() === "kimi-k2.6" ||
      model.id === "kimi-code/kimi-for-coding" ||
      model.id === "kimi-for-coding",
  );
  if (!selectedModel) {
    return BUILT_IN_MODELS;
  }
  return [
    {
      slug: selectedModel.id,
      name: selectedModel.name,
      isCustom: false,
      multiModal: false,
      capabilities: {
        reasoningEffortLevels: [],
        supportsFastMode: false,
        supportsThinkingToggle: true,
        contextWindowOptions: [],
        promptInjectedEffortLevels: [],
      } satisfies ModelCapabilities,
    },
  ];
}

type KimiCliWireInfo = {
  readonly cliVersion: string | null;
  readonly wireVersion: string | null;
  readonly capabilities?: unknown;
};

function normalizeVersion(value: string | undefined): string | null {
  if (!value) {
    return null;
  }
  const match = value.match(/\b(\d+)(?:\.(\d+))?(?:\.(\d+))?\b/);
  if (!match) {
    return null;
  }
  return [match[1], match[2] ?? "0", match[3] ?? "0"].join(".");
}

function compareVersions(left: string, right: string): number {
  const leftParts = left.split(".").map((part) => Number.parseInt(part, 10) || 0);
  const rightParts = right.split(".").map((part) => Number.parseInt(part, 10) || 0);
  for (let index = 0; index < 3; index += 1) {
    const diff = (leftParts[index] ?? 0) - (rightParts[index] ?? 0);
    if (diff !== 0) {
      return diff;
    }
  }
  return 0;
}

function findNestedString(
  value: unknown,
  keys: ReadonlySet<string>,
  depth = 0,
): string | undefined {
  if (depth > 4) {
    return undefined;
  }
  if (Array.isArray(value)) {
    for (const entry of value) {
      const nested = findNestedString(entry, keys, depth + 1);
      if (nested) {
        return nested;
      }
    }
    return undefined;
  }
  if (!value || typeof value !== "object") {
    return undefined;
  }
  const record = value as Record<string, unknown>;
  for (const [key, entry] of Object.entries(record)) {
    if (keys.has(key.toLowerCase()) && typeof entry === "string") {
      return entry;
    }
  }
  for (const entry of Object.values(record)) {
    const nested = findNestedString(entry, keys, depth + 1);
    if (nested) {
      return nested;
    }
  }
  return undefined;
}

function findNestedValue(value: unknown, keys: ReadonlySet<string>, depth = 0): unknown {
  if (depth > 4 || !value || typeof value !== "object") {
    return undefined;
  }
  if (Array.isArray(value)) {
    for (const entry of value) {
      const nested = findNestedValue(entry, keys, depth + 1);
      if (nested !== undefined) {
        return nested;
      }
    }
    return undefined;
  }
  const record = value as Record<string, unknown>;
  for (const [key, entry] of Object.entries(record)) {
    if (keys.has(key.toLowerCase())) {
      return entry;
    }
  }
  for (const entry of Object.values(record)) {
    const nested = findNestedValue(entry, keys, depth + 1);
    if (nested !== undefined) {
      return nested;
    }
  }
  return undefined;
}

export function parseKimiInfoOutput(output: string): KimiCliWireInfo {
  const trimmed = output.trim();
  if (!trimmed) {
    return {
      cliVersion: null,
      wireVersion: null,
    };
  }

  const cliKeys = new Set(["cliversion", "cli_version", "version", "kimiversion"]);
  const wireKeys = new Set([
    "wireversion",
    "wire_version",
    "wireprotocolversion",
    "wire_protocol_version",
    "protocolversion",
    "protocol_version",
  ]);
  const capabilityKeys = new Set(["capabilities", "servercapabilities", "server_capabilities"]);

  try {
    const parsed = JSON.parse(trimmed);
    const cliVersion = normalizeVersion(findNestedString(parsed, cliKeys));
    const wireVersion = normalizeVersion(findNestedString(parsed, wireKeys));
    const capabilities = findNestedValue(parsed, capabilityKeys);
    return {
      cliVersion,
      wireVersion,
      ...(capabilities !== undefined ? { capabilities } : {}),
    };
  } catch {
    const cliVersion =
      normalizeVersion(
        trimmed.match(
          /(?:kimi(?:\s+code)?|cli)(?:\s+cli)?(?:\s+version)?\s*[:=]?\s*v?(\d+(?:\.\d+){0,2})/i,
        )?.[1],
      ) ?? parseGenericCliVersion(trimmed);
    const wireVersion = normalizeVersion(
      trimmed.match(/(?:wire|protocol)(?:[_\s-]*version)?\s*[:=]?\s*v?(\d+(?:\.\d+){0,2})/i)?.[1],
    );
    return {
      cliVersion,
      wireVersion,
    };
  }
}

export function evaluateKimiCliWireCompatibility(info: KimiCliWireInfo): {
  readonly status: "ready" | "warning";
  readonly message?: string;
} {
  if (!info.wireVersion) {
    return {
      status: "warning",
      message:
        "Kimi Code CLI is installed, but ShioriCode could not determine its wire protocol version.",
    };
  }
  if (compareVersions(info.wireVersion, MIN_SUPPORTED_KIMI_WIRE_VERSION) < 0) {
    return {
      status: "warning",
      message: `Kimi Code wire protocol v${info.wireVersion} may be too old for ShioriCode. Upgrade to wire v${MIN_SUPPORTED_KIMI_WIRE_VERSION} or newer for full compatibility.`,
    };
  }
  return { status: "ready" };
}

const runKimiCommand = Effect.fn("runKimiCommand")(function* (args: ReadonlyArray<string>) {
  const settingsService = yield* ServerSettingsService;
  const kimiSettings = yield* settingsService.getSettings.pipe(
    Effect.map((settings) => settings.providers.kimiCode),
  );
  const binaryPath = kimiSettings.binaryPath.trim() || "kimi";
  const shareDir = kimiSettings.shareDir.trim();
  const command = ChildProcess.make(binaryPath, [...args], {
    shell: process.platform === "win32",
    env: {
      ...process.env,
      ...(shareDir ? { KIMI_SHARE_DIR: shareDir } : {}),
    },
  });
  return yield* spawnAndCollect(binaryPath, command);
});

export const checkKimiCodeProviderStatus = Effect.fn("checkKimiCodeProviderStatus")(function* () {
  const kimiSettings = yield* Effect.service(ServerSettingsService).pipe(
    Effect.flatMap((service) => service.getSettings),
    Effect.map((settings) => settings.providers.kimiCode),
  );
  const checkedAt = new Date().toISOString();
  const models = modelsFromConfig(kimiSettings);

  if (!kimiSettings.enabled) {
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
        message: "Kimi Code is disabled in ShioriCode settings.",
      },
    });
  }

  const versionProbe = yield* runKimiCommand(["--version"]).pipe(
    Effect.timeoutOption(DEFAULT_TIMEOUT_MS),
    Effect.result,
  );

  if (Result.isFailure(versionProbe)) {
    const error = versionProbe.failure;
    return buildServerProvider({
      provider: PROVIDER,
      enabled: true,
      checkedAt,
      models,
      probe: {
        installed: !isCommandMissingCause(error),
        version: null,
        status: "error",
        auth: { status: "unknown" },
        message: isCommandMissingCause(error)
          ? "Kimi Code CLI (`kimi`) is not installed or not on PATH."
          : `Failed to execute Kimi Code CLI health check: ${
              error instanceof Error ? error.message : String(error)
            }.`,
      },
    });
  }

  if (Result.isSuccess(versionProbe) && Option.isNone(versionProbe.success)) {
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
        message: "Timed out while checking Kimi Code CLI version.",
      },
    });
  }

  const versionResult =
    Result.isSuccess(versionProbe) && Option.isSome(versionProbe.success)
      ? versionProbe.success.value
      : null;
  const version = versionResult ? parseGenericCliVersion(versionResult.stdout) : null;
  const infoJsonProbe = yield* runKimiCommand(["info", "--json"]).pipe(
    Effect.timeoutOption(DEFAULT_TIMEOUT_MS),
    Effect.result,
  );
  const infoJsonResult =
    Result.isSuccess(infoJsonProbe) && Option.isSome(infoJsonProbe.success)
      ? infoJsonProbe.success.value
      : null;
  const infoTextProbe =
    infoJsonResult && infoJsonResult.code === 0
      ? null
      : yield* runKimiCommand(["info"]).pipe(
          Effect.timeoutOption(DEFAULT_TIMEOUT_MS),
          Effect.result,
        );
  const infoTextResult =
    infoTextProbe && Result.isSuccess(infoTextProbe) && Option.isSome(infoTextProbe.success)
      ? infoTextProbe.success.value
      : null;
  const infoResult =
    infoJsonResult && infoJsonResult.code === 0
      ? infoJsonResult
      : infoTextResult && infoTextResult.code === 0
        ? infoTextResult
        : null;
  const cliWireInfo = infoResult
    ? parseKimiInfoOutput([infoResult.stdout, infoResult.stderr].filter(Boolean).join("\n"))
    : {
        cliVersion: version,
        wireVersion: null,
      };
  const compatibility = evaluateKimiCliWireCompatibility(cliWireInfo);
  const shareDir = kimiSettings.shareDir.trim() || undefined;
  const loggedIn = isLoggedIn(shareDir);

  return buildServerProvider({
    provider: PROVIDER,
    enabled: true,
    checkedAt,
    models,
    probe: {
      installed: true,
      version: version ?? cliWireInfo.cliVersion,
      status: loggedIn ? compatibility.status : "error",
      auth: {
        status: loggedIn ? "authenticated" : "unauthenticated",
        ...(loggedIn ? { label: "Signed in to Kimi Code" } : {}),
      },
      ...(!loggedIn
        ? {
            message: "Kimi Code CLI is not authenticated. Run `kimi login` and try again.",
          }
        : compatibility.message
          ? {
              message: compatibility.message,
            }
          : {}),
    },
  });
});

export const KimiCodeProviderLive = Layer.effect(
  KimiCodeProvider,
  Effect.gen(function* () {
    const serverSettings = yield* ServerSettingsService;
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const checkProvider = checkKimiCodeProviderStatus().pipe(
      Effect.provideService(ServerSettingsService, serverSettings),
      Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
    );

    return yield* makeManagedServerProvider<KimiCodeSettings>({
      getSettings: serverSettings.getSettings.pipe(
        Effect.map((settings) => settings.providers.kimiCode),
        Effect.orDie,
      ),
      streamSettings: serverSettings.streamChanges.pipe(
        Stream.map((settings) => settings.providers.kimiCode),
      ),
      haveSettingsChanged: (previous, next) =>
        previous.enabled !== next.enabled ||
        previous.binaryPath !== next.binaryPath ||
        previous.shareDir !== next.shareDir ||
        JSON.stringify(previous.customModels) !== JSON.stringify(next.customModels),
      checkProvider,
      buildInitialSnapshot: buildPendingKimiCodeProviderStatus,
      refreshInterval: "60 seconds",
    });
  }),
);
