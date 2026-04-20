/**
 * ProviderRegistryLive - Aggregates provider-specific snapshot services.
 *
 * @module ProviderRegistryLive
 */
import type { ProviderKind, ServerProvider } from "contracts";
import { Effect, Equal, Layer, PubSub, Ref, Stream } from "effect";

import { ClaudeProviderLive } from "./ClaudeProvider";
import { CodexProviderLive } from "./CodexProvider";
import { KimiCodeProviderLive } from "./KimiCodeProvider";
import { ShioriProviderLive } from "./ShioriProvider";
import type { ClaudeProviderShape } from "../Services/ClaudeProvider";
import { ClaudeProvider } from "../Services/ClaudeProvider";
import type { CodexProviderShape } from "../Services/CodexProvider";
import { CodexProvider } from "../Services/CodexProvider";
import type { KimiCodeProviderShape } from "../Services/KimiCodeProvider";
import { KimiCodeProvider } from "../Services/KimiCodeProvider";
import type { ShioriProviderShape } from "../Services/ShioriProvider";
import { ShioriProvider } from "../Services/ShioriProvider";
import { ProviderRegistry, type ProviderRegistryShape } from "../Services/ProviderRegistry";

const loadProviders = (
  shioriProvider: ShioriProviderShape,
  kimiCodeProvider: KimiCodeProviderShape,
  codexProvider: CodexProviderShape,
  claudeProvider: ClaudeProviderShape,
): Effect.Effect<readonly [ServerProvider, ServerProvider, ServerProvider, ServerProvider]> =>
  Effect.all(
    [
      shioriProvider.getSnapshot,
      kimiCodeProvider.getSnapshot,
      codexProvider.getSnapshot,
      claudeProvider.getSnapshot,
    ],
    {
      concurrency: "unbounded",
    },
  );

export const haveProvidersChanged = (
  previousProviders: ReadonlyArray<ServerProvider>,
  nextProviders: ReadonlyArray<ServerProvider>,
): boolean => !Equal.equals(previousProviders, nextProviders);

export const ProviderRegistryLive = Layer.effect(
  ProviderRegistry,
  Effect.gen(function* () {
    const shioriProvider = yield* ShioriProvider;
    const kimiCodeProvider = yield* KimiCodeProvider;
    const codexProvider = yield* CodexProvider;
    const claudeProvider = yield* ClaudeProvider;
    const changesPubSub = yield* Effect.acquireRelease(
      PubSub.unbounded<ReadonlyArray<ServerProvider>>(),
      PubSub.shutdown,
    );
    const providersRef = yield* Ref.make<ReadonlyArray<ServerProvider>>(
      yield* loadProviders(shioriProvider, kimiCodeProvider, codexProvider, claudeProvider),
    );

    const syncProviders = Effect.fn("syncProviders")(function* (options?: {
      readonly publish?: boolean;
    }) {
      const previousProviders = yield* Ref.get(providersRef);
      const providers = yield* loadProviders(
        shioriProvider,
        kimiCodeProvider,
        codexProvider,
        claudeProvider,
      );
      yield* Ref.set(providersRef, providers);

      if (options?.publish !== false && haveProvidersChanged(previousProviders, providers)) {
        yield* PubSub.publish(changesPubSub, providers);
      }

      return providers;
    });

    yield* Stream.runForEach(shioriProvider.streamChanges, () => syncProviders()).pipe(
      Effect.forkScoped,
    );
    yield* Stream.runForEach(kimiCodeProvider.streamChanges, () => syncProviders()).pipe(
      Effect.forkScoped,
    );
    yield* Stream.runForEach(codexProvider.streamChanges, () => syncProviders()).pipe(
      Effect.forkScoped,
    );
    yield* Stream.runForEach(claudeProvider.streamChanges, () => syncProviders()).pipe(
      Effect.forkScoped,
    );

    const refresh = Effect.fn("refresh")(function* (provider?: ProviderKind) {
      switch (provider) {
        case "shiori":
          yield* shioriProvider.refresh;
          break;
        case "kimiCode":
          yield* kimiCodeProvider.refresh;
          break;
        case "codex":
          yield* codexProvider.refresh;
          break;
        case "claudeAgent":
          yield* claudeProvider.refresh;
          break;
        default:
          yield* Effect.all(
            [
              shioriProvider.refresh,
              kimiCodeProvider.refresh,
              codexProvider.refresh,
              claudeProvider.refresh,
            ],
            {
              concurrency: "unbounded",
            },
          );
          break;
      }
      return yield* syncProviders();
    });

    return {
      getProviders: Ref.get(providersRef).pipe(
        Effect.tapError(Effect.logError),
        Effect.orElseSucceed(() => []),
      ),
      refresh: (provider?: ProviderKind) =>
        refresh(provider).pipe(
          Effect.tapError(Effect.logError),
          Effect.orElseSucceed(() => []),
        ),
      get streamChanges() {
        return Stream.fromPubSub(changesPubSub);
      },
    } satisfies ProviderRegistryShape;
  }),
).pipe(
  Layer.provideMerge(ShioriProviderLive),
  Layer.provideMerge(KimiCodeProviderLive),
  Layer.provideMerge(CodexProviderLive),
  Layer.provideMerge(ClaudeProviderLive),
);
