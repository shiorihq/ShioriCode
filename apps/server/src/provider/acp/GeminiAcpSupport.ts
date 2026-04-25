import type { GeminiSettings } from "contracts";
import { Effect, Layer, Scope } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";
import type * as EffectAcpErrors from "effect-acp/errors";

import { collectStreamAsString } from "../providerSnapshot.ts";
import {
  AcpSessionRuntime,
  type AcpSessionRuntimeOptions,
  type AcpSessionRuntimeShape,
  type AcpSpawnInput,
} from "./AcpSessionRuntime.ts";

const GEMINI_AUTH_METHOD_ID = "oauth-personal";
const GEMINI_ACP_FLAGS = ["--acp", "--experimental-acp"] as const;
const GEMINI_ACP_CLI_MANAGED_MODELS = new Set([
  "auto",
  "default",
  "latest",
  "pro",
  "flash",
  "flash-lite",
  "auto-gemini-2.5",
  "auto-gemini-3",
  "gemini-2.5-pro",
  "gemini-2.5-flash",
  "gemini-2.5-flash-lite",
  "gemini-3-pro-preview",
  "gemini-3-flash-preview",
]);
export type GeminiAcpFlag = (typeof GEMINI_ACP_FLAGS)[number];

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

export function detectGeminiAcpFlag(
  binaryPath: string,
): Effect.Effect<GeminiAcpFlag, never, ChildProcessSpawner.ChildProcessSpawner> {
  const command = ChildProcess.make(binaryPath, ["--help"], {
    shell: process.platform === "win32",
  });
  return collectStreamAsStringFromCommand(binaryPath, command).pipe(
    Effect.map((output) => {
      if (output.includes("--acp")) return "--acp" as const;
      return "--experimental-acp" as const;
    }),
    Effect.catch(() => Effect.succeed("--acp" as const)),
  );
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
}): AcpSpawnInput {
  const binaryPath = trimOrUndefined(input.geminiSettings.binaryPath) ?? "gemini";
  const model = resolveGeminiAcpCliModel(input.model);
  const googleCloudProject = trimOrUndefined(input.geminiSettings.googleCloudProject);
  return {
    command: binaryPath,
    args: [input.acpFlag, ...(model ? (["--model", model] as const) : [])],
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

export const makeGeminiAcpRuntime = (
  input: GeminiAcpRuntimeInput,
): Effect.Effect<AcpSessionRuntimeShape, EffectAcpErrors.AcpError, Scope.Scope> =>
  Effect.gen(function* () {
    const explicitFlag = normalizeGeminiAcpFlag(input.geminiSettings.acpFlag);
    const acpFlag =
      explicitFlag ??
      (yield* detectGeminiAcpFlag(input.geminiSettings.binaryPath || "gemini").pipe(
        Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, input.childProcessSpawner),
      ));
    const acpContext = yield* Layer.build(
      AcpSessionRuntime.layer({
        ...input,
        spawn: buildGeminiAcpSpawnInput({
          geminiSettings: input.geminiSettings,
          cwd: input.cwd,
          acpFlag,
          ...(input.model !== undefined ? { model: input.model } : {}),
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
