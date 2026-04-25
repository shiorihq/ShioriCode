import { type CursorModelOptions, type CursorSettings } from "contracts";
import { Effect, Layer, Scope } from "effect";
import { ChildProcessSpawner } from "effect/unstable/process";
import type * as EffectAcpErrors from "effect-acp/errors";
import type * as EffectAcpSchema from "effect-acp/schema";

import {
  CURSOR_PARAMETERIZED_MODEL_PICKER_CAPABILITIES,
  resolveCursorAcpBaseModelId,
  resolveCursorAcpConfigUpdates,
} from "../Layers/CursorProvider.ts";
import {
  AcpSessionRuntime,
  type AcpSessionRuntimeOptions,
  type AcpSessionRuntimeShape,
  type AcpSpawnInput,
} from "./AcpSessionRuntime.ts";

type CursorAcpRuntimeCursorSettings = Pick<CursorSettings, "apiEndpoint" | "binaryPath">;

export interface CursorAcpRuntimeInput extends Omit<
  AcpSessionRuntimeOptions,
  "authMethodId" | "clientCapabilities" | "spawn"
> {
  readonly childProcessSpawner: ChildProcessSpawner.ChildProcessSpawner["Service"];
  readonly cursorSettings: CursorAcpRuntimeCursorSettings | null | undefined;
}

export interface CursorAcpModelSelectionErrorContext {
  readonly cause: EffectAcpErrors.AcpError;
  readonly step: "set-config-option" | "set-model";
  readonly configId?: string;
}

export function buildCursorAcpSpawnInput(
  cursorSettings: CursorAcpRuntimeCursorSettings | null | undefined,
  cwd: string,
): AcpSpawnInput {
  return {
    command: cursorSettings?.binaryPath || "agent",
    args: [
      ...(cursorSettings?.apiEndpoint ? (["-e", cursorSettings.apiEndpoint] as const) : []),
      "acp",
    ],
    cwd,
  };
}

export const makeCursorAcpRuntime = (
  input: CursorAcpRuntimeInput,
): Effect.Effect<AcpSessionRuntimeShape, EffectAcpErrors.AcpError, Scope.Scope> =>
  Effect.gen(function* () {
    const acpContext = yield* Layer.build(
      AcpSessionRuntime.layer({
        ...input,
        spawn: buildCursorAcpSpawnInput(input.cursorSettings, input.cwd),
        authMethodId: "cursor_login",
        clientCapabilities: CURSOR_PARAMETERIZED_MODEL_PICKER_CAPABILITIES,
      }).pipe(
        Layer.provide(
          Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, input.childProcessSpawner),
        ),
      ),
    );
    return yield* Effect.service(AcpSessionRuntime).pipe(Effect.provide(acpContext));
  });

interface CursorAcpModelSelectionRuntime {
  readonly getConfigOptions: AcpSessionRuntimeShape["getConfigOptions"];
  readonly setConfigOption: (
    configId: string,
    value: string | boolean,
  ) => Effect.Effect<unknown, EffectAcpErrors.AcpError>;
  readonly setModel: (model: string) => Effect.Effect<unknown, EffectAcpErrors.AcpError>;
}

function findModelConfigOption(
  configOptions: ReadonlyArray<EffectAcpSchema.SessionConfigOption>,
): EffectAcpSchema.SessionConfigOption | undefined {
  return configOptions.find((option) => option.category === "model" || option.id === "model");
}

function collectModelOptionValues(
  configOption: EffectAcpSchema.SessionConfigOption | undefined,
): ReadonlyArray<string> {
  if (!configOption || configOption.type !== "select") {
    return [];
  }
  return configOption.options.flatMap((entry) =>
    "value" in entry ? [entry.value] : entry.options.map((option) => option.value),
  );
}

function resolveSupportedCursorModel(input: {
  readonly requestedModel: string;
  readonly configOptions: ReadonlyArray<EffectAcpSchema.SessionConfigOption>;
}): string | undefined {
  const modelConfigOption = findModelConfigOption(input.configOptions);
  const supportedValues = collectModelOptionValues(modelConfigOption);
  if (supportedValues.length === 0) {
    return input.requestedModel;
  }

  if (supportedValues.includes(input.requestedModel)) {
    return input.requestedModel;
  }

  const aliases = [
    input.requestedModel === "auto" ? "default" : undefined,
    input.requestedModel === "composer-2" ? "composer" : undefined,
    input.requestedModel.startsWith("composer-") ? "composer" : undefined,
    "default",
  ].filter((value): value is string => typeof value === "string");

  for (const alias of aliases) {
    if (supportedValues.includes(alias)) {
      return alias;
    }
  }

  const currentValue =
    modelConfigOption?.type === "select" && typeof modelConfigOption.currentValue === "string"
      ? modelConfigOption.currentValue.trim()
      : "";
  return currentValue && supportedValues.includes(currentValue) ? currentValue : undefined;
}

export function applyCursorAcpModelSelection<E>(input: {
  readonly runtime: CursorAcpModelSelectionRuntime;
  readonly model: string | null | undefined;
  readonly modelOptions: CursorModelOptions | null | undefined;
  readonly mapError: (context: CursorAcpModelSelectionErrorContext) => E;
}): Effect.Effect<void, E> {
  return Effect.gen(function* () {
    const configOptions = yield* input.runtime.getConfigOptions;
    const requestedModel = resolveCursorAcpBaseModelId(input.model);
    const model = resolveSupportedCursorModel({
      requestedModel,
      configOptions,
    });
    if (model !== undefined) {
      yield* input.runtime.setModel(model).pipe(
        Effect.mapError((cause) =>
          input.mapError({
            cause,
            step: "set-model",
          }),
        ),
      );
    }

    const configUpdates = resolveCursorAcpConfigUpdates(configOptions, input.modelOptions);
    for (const update of configUpdates) {
      yield* input.runtime.setConfigOption(update.configId, update.value).pipe(
        Effect.mapError((cause) =>
          input.mapError({
            cause,
            step: "set-config-option",
            configId: update.configId,
          }),
        ),
      );
    }
  });
}
