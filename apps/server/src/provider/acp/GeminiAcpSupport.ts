import type {
  GeminiSettings,
  ProviderApprovalPolicy,
  ProviderInteractionMode,
  RuntimeMode,
} from "contracts";
import { Effect, Layer, Option, Schema, Scope } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";
import * as EffectAcpErrors from "effect-acp/errors";
import type * as EffectAcpSchema from "effect-acp/schema";

import { collectStreamAsString } from "../providerSnapshot.ts";
import {
  AcpSessionRuntime,
  type AcpSessionRuntimeOptions,
  type AcpSessionRuntimeShape,
  type AcpSpawnInput,
} from "./AcpSessionRuntime.ts";

const GEMINI_AUTH_METHOD_ID = "oauth-personal";
const GEMINI_ACP_FLAGS = ["--acp", "--experimental-acp"] as const;
const GEMINI_ACP_CLI_MANAGED_MODELS = new Set(["auto", "default"]);
const GEMINI_ACP_FLAG_CACHE = new Map<string, GeminiAcpFlagDetection>();
const GEMINI_AUTH_READINESS_CACHE = new Map<string, GeminiAuthReadinessCacheEntry>();
const DEFAULT_GEMINI_AUTH_READINESS_CACHE_TTL_MS = 5_000;
const DEFAULT_GEMINI_AUTH_READINESS_TIMEOUT_MS = 4_000;
export type GeminiAcpFlag = (typeof GEMINI_ACP_FLAGS)[number];
export type GeminiAcpApprovalMode = "default" | "plan" | "yolo";

export interface GeminiAcpFlagDetection {
  readonly supportedFlag: GeminiAcpFlag | null;
  readonly reason: "help-output" | "flag-not-found" | "help-command-failed";
  readonly raw: string;
}

export interface GeminiAuthReadiness {
  readonly status: "authenticated" | "auth_required" | "unknown";
  readonly reason:
    | "probe-authenticated"
    | "probe-auth-required"
    | "oauth-cache-stale"
    | "probe-timeout"
    | "probe-failed";
  readonly oauthCacheHint: boolean;
  readonly message?: string;
  readonly raw?: string;
}

interface GeminiAuthReadinessCacheEntry {
  readonly checkedAtMs: number;
  readonly readiness: GeminiAuthReadiness;
}

type GeminiAcpRuntimeGeminiSettings = Pick<
  GeminiSettings,
  "binaryPath" | "googleCloudProject" | "acpFlag"
>;

export interface GeminiAcpRuntimeInput extends Omit<
  AcpSessionRuntimeOptions,
  "authMethodId" | "clientCapabilities" | "spawn"
> {
  readonly childProcessSpawner: ChildProcessSpawner.ChildProcessSpawner["Service"];
  readonly geminiSettings: GeminiAcpRuntimeGeminiSettings;
  readonly model?: string | null;
  readonly approvalMode: GeminiAcpApprovalMode;
}

function trimOrUndefined(value: string | null | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

export function normalizeGeminiAcpFlag(value: string | null | undefined): GeminiAcpFlag | null {
  const trimmed = value?.trim();
  if (!trimmed) return null;
  return GEMINI_ACP_FLAGS.includes(trimmed as GeminiAcpFlag) ? (trimmed as GeminiAcpFlag) : null;
}

export function resolveGeminiAcpCliModel(model: string | null | undefined): string | undefined {
  const trimmed = trimOrUndefined(model);
  if (!trimmed) return undefined;
  return GEMINI_ACP_CLI_MANAGED_MODELS.has(trimmed) ? undefined : trimmed;
}

export function resolveGeminiAcpApprovalMode(input: {
  readonly runtimeMode: RuntimeMode;
  readonly approvalPolicy?: ProviderApprovalPolicy | undefined;
  readonly interactionMode?: ProviderInteractionMode | undefined;
}): GeminiAcpApprovalMode {
  if (input.interactionMode === "plan") {
    return "plan";
  }
  if (input.approvalPolicy === "never" || input.runtimeMode === "full-access") {
    return "yolo";
  }
  return "default";
}

export function selectGeminiAutoApprovedPermissionOption(
  request: EffectAcpSchema.RequestPermissionRequest,
  approvalMode: GeminiAcpApprovalMode,
): string | undefined {
  if (approvalMode !== "yolo") {
    return undefined;
  }
  const allowAlwaysOption = request.options.find((option) => option.kind === "allow_always");
  if (allowAlwaysOption?.optionId?.trim()) return allowAlwaysOption.optionId.trim();
  const allowOnceOption = request.options.find((option) => option.kind === "allow_once");
  if (allowOnceOption?.optionId?.trim()) return allowOnceOption.optionId.trim();
  return undefined;
}

export function detectGeminiAcpFlag(
  binaryPath: string,
  version: string | null | undefined = null,
): Effect.Effect<GeminiAcpFlagDetection, never, ChildProcessSpawner.ChildProcessSpawner> {
  const cacheKey = `${binaryPath}\0${version ?? ""}`;
  const cached = GEMINI_ACP_FLAG_CACHE.get(cacheKey);
  if (cached) {
    return Effect.succeed(cached);
  }
  const command = ChildProcess.make(binaryPath, ["--help"], {
    shell: process.platform === "win32",
  });
  return collectStreamAsStringFromCommand(binaryPath, command).pipe(
    Effect.map((raw) => {
      const supportedFlag = resolveGeminiAcpFlagFromHelp(raw);
      return {
        supportedFlag,
        reason: supportedFlag ? "help-output" : "flag-not-found",
        raw,
      } satisfies GeminiAcpFlagDetection;
    }),
    Effect.catch((error) =>
      Effect.succeed({
        supportedFlag: null,
        reason: "help-command-failed",
        raw: error instanceof Error ? error.message : String(error),
      } satisfies GeminiAcpFlagDetection),
    ),
    Effect.tap((detection) => Effect.sync(() => GEMINI_ACP_FLAG_CACHE.set(cacheKey, detection))),
  );
}

export function clearGeminiAcpSupportCachesForTest(): void {
  GEMINI_ACP_FLAG_CACHE.clear();
  GEMINI_AUTH_READINESS_CACHE.clear();
}

function resolveGeminiAcpFlagFromHelp(raw: string): GeminiAcpFlag | null {
  if (helpMentionsFlag(raw, "--acp")) return "--acp";
  if (helpMentionsFlag(raw, "--experimental-acp")) return "--experimental-acp";
  return null;
}

function helpMentionsFlag(raw: string, flag: GeminiAcpFlag): boolean {
  const escaped = flag.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(^|[\\s,])${escaped}(?=($|[\\s,=]))`).test(raw);
}

function collectStreamAsStringFromCommand(binaryPath: string, command: ChildProcess.Command) {
  return Effect.gen(function* () {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const child = yield* spawner.spawn(command);
    const [stdout, stderr] = yield* Effect.all(
      [collectStreamAsString(child.stdout), collectStreamAsString(child.stderr), child.exitCode],
      { concurrency: "unbounded" },
    );
    return `${stdout}\n${stderr}`;
  }).pipe(
    Effect.scoped,
    Effect.mapError((cause) => new Error(`Failed to run ${binaryPath} --help`, { cause })),
  );
}

export function buildGeminiAcpSpawnInput(input: {
  readonly geminiSettings: GeminiAcpRuntimeGeminiSettings;
  readonly cwd: string;
  readonly acpFlag: GeminiAcpFlag;
  readonly model?: string | null;
  readonly approvalMode: GeminiAcpApprovalMode;
}): AcpSpawnInput {
  const binaryPath = trimOrUndefined(input.geminiSettings.binaryPath) ?? "gemini";
  const model = resolveGeminiAcpCliModel(input.model);
  const googleCloudProject = trimOrUndefined(input.geminiSettings.googleCloudProject);
  return {
    command: binaryPath,
    args: [
      input.acpFlag,
      "--approval-mode",
      input.approvalMode,
      ...(model ? (["--model", model] as const) : []),
    ],
    cwd: input.cwd,
    env: {
      // Force the Google Account / Code Assist auth path so the provider uses
      // the user's Gemini subscription instead of an ambient API key or Vertex
      // credential that may happen to be present in the shell environment.
      GEMINI_API_KEY: undefined,
      GOOGLE_API_KEY: undefined,
      GOOGLE_GENAI_USE_VERTEXAI: undefined,
      GOOGLE_APPLICATION_CREDENTIALS: undefined,
      ...(googleCloudProject
        ? {
            GOOGLE_CLOUD_PROJECT: googleCloudProject,
            GOOGLE_CLOUD_PROJECT_ID: googleCloudProject,
          }
        : {}),
    },
  };
}

export function classifyGeminiAuthReadiness(input: {
  readonly outcome: "authenticated" | "auth_required" | "timeout" | "failed";
  readonly oauthCacheHint: boolean;
  readonly raw?: string;
}): GeminiAuthReadiness {
  switch (input.outcome) {
    case "authenticated":
      return {
        status: "authenticated",
        reason: "probe-authenticated",
        oauthCacheHint: input.oauthCacheHint,
        ...(input.raw ? { raw: input.raw } : {}),
      };
    case "auth_required":
      return {
        status: "auth_required",
        reason: input.oauthCacheHint ? "oauth-cache-stale" : "probe-auth-required",
        oauthCacheHint: input.oauthCacheHint,
        message: input.oauthCacheHint
          ? "Gemini OAuth files exist, but the ACP auth probe rejected them. Sign in with Gemini again."
          : "Gemini CLI is not authenticated. Run `gemini` and choose Sign in with Google.",
        ...(input.raw ? { raw: input.raw } : {}),
      };
    case "timeout":
      return {
        status: "unknown",
        reason: "probe-timeout",
        oauthCacheHint: input.oauthCacheHint,
        message: input.oauthCacheHint
          ? "Gemini OAuth files exist, but the ACP auth probe timed out before they could be verified."
          : "Could not verify Gemini authentication because the ACP auth probe timed out.",
        ...(input.raw ? { raw: input.raw } : {}),
      };
    case "failed":
      return {
        status: "unknown",
        reason: "probe-failed",
        oauthCacheHint: input.oauthCacheHint,
        message: input.oauthCacheHint
          ? "Gemini OAuth files exist, but the ACP auth probe failed before they could be verified."
          : "Could not verify Gemini authentication with the ACP auth probe.",
        ...(input.raw ? { raw: input.raw } : {}),
      };
  }
}

export function classifyGeminiAuthProbeError(
  error: EffectAcpErrors.AcpError,
  oauthCacheHint: boolean,
): GeminiAuthReadiness {
  const raw = error.message;
  const lower = raw.toLowerCase();
  const requestError = Schema.is(EffectAcpErrors.AcpRequestError)(error) ? error : undefined;
  const authRequired =
    requestError?.code === -32000 ||
    (lower.includes("auth") &&
      (lower.includes("required") || lower.includes("login") || lower.includes("sign in")));
  return classifyGeminiAuthReadiness({
    outcome: authRequired ? "auth_required" : "failed",
    oauthCacheHint,
    raw,
  });
}

export function checkGeminiAcpAuthReadiness(input: {
  readonly geminiSettings: GeminiAcpRuntimeGeminiSettings;
  readonly childProcessSpawner: ChildProcessSpawner.ChildProcessSpawner["Service"];
  readonly cwd: string;
  readonly acpFlag: GeminiAcpFlag;
  readonly oauthCacheHint: boolean;
  readonly cacheKeyVersion?: string | null;
  readonly cacheTtlMs?: number;
  readonly timeoutMs?: number;
}): Effect.Effect<GeminiAuthReadiness, never> {
  return Effect.gen(function* () {
    const binaryPath = trimOrUndefined(input.geminiSettings.binaryPath) ?? "gemini";
    const cacheKey = [
      binaryPath,
      input.cacheKeyVersion ?? "",
      input.acpFlag,
      trimOrUndefined(input.geminiSettings.googleCloudProject) ?? "",
    ].join("\0");
    const now = Date.now();
    const cached = GEMINI_AUTH_READINESS_CACHE.get(cacheKey);
    const cacheTtlMs = input.cacheTtlMs ?? DEFAULT_GEMINI_AUTH_READINESS_CACHE_TTL_MS;
    if (cached && now - cached.checkedAtMs <= cacheTtlMs) {
      return cached.readiness;
    }

    const probe = makeGeminiAcpRuntime({
      geminiSettings: {
        ...input.geminiSettings,
        acpFlag: input.acpFlag,
      },
      childProcessSpawner: input.childProcessSpawner,
      cwd: input.cwd,
      mcpServers: [],
      clientInfo: { name: "shiori-code-auth-probe", version: "0.0.0" },
      approvalMode: "default",
    }).pipe(
      Effect.flatMap((runtime) => runtime.start()),
      Effect.scoped,
      Effect.as(
        classifyGeminiAuthReadiness({
          outcome: "authenticated",
          oauthCacheHint: input.oauthCacheHint,
        }),
      ),
      Effect.catch((error: EffectAcpErrors.AcpError) =>
        Effect.succeed(classifyGeminiAuthProbeError(error, input.oauthCacheHint)),
      ),
      Effect.timeoutOption(input.timeoutMs ?? DEFAULT_GEMINI_AUTH_READINESS_TIMEOUT_MS),
      Effect.map((result) =>
        Option.isSome(result)
          ? result.value
          : classifyGeminiAuthReadiness({
              outcome: "timeout",
              oauthCacheHint: input.oauthCacheHint,
            }),
      ),
    );

    const readiness = yield* probe;
    GEMINI_AUTH_READINESS_CACHE.set(cacheKey, { checkedAtMs: now, readiness });
    return readiness;
  });
}

export const makeGeminiAcpRuntime = (
  input: GeminiAcpRuntimeInput,
): Effect.Effect<AcpSessionRuntimeShape, EffectAcpErrors.AcpError, Scope.Scope> =>
  Effect.gen(function* () {
    const explicitFlag = normalizeGeminiAcpFlag(input.geminiSettings.acpFlag);
    const acpFlag =
      explicitFlag ??
      (yield* detectGeminiAcpFlag(input.geminiSettings.binaryPath || "gemini").pipe(
        Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, input.childProcessSpawner),
      )).supportedFlag;
    if (!acpFlag) {
      return yield* new EffectAcpErrors.AcpTransportError({
        detail: "Gemini CLI does not expose an ACP flag in `gemini --help` output.",
        cause: new Error("Gemini ACP flag detection failed"),
      });
    }
    const acpContext = yield* Layer.build(
      AcpSessionRuntime.layer({
        ...input,
        spawn: buildGeminiAcpSpawnInput({
          geminiSettings: input.geminiSettings,
          cwd: input.cwd,
          acpFlag,
          ...(input.model !== undefined ? { model: input.model } : {}),
          approvalMode: input.approvalMode,
        }),
        authMethodId: GEMINI_AUTH_METHOD_ID,
        clientCapabilities: {
          fs: {
            readTextFile: false,
            writeTextFile: false,
          },
          terminal: false,
        },
      }).pipe(
        Layer.provide(
          Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, input.childProcessSpawner),
        ),
      ),
    );
    return yield* Effect.service(AcpSessionRuntime).pipe(Effect.provide(acpContext));
  });
