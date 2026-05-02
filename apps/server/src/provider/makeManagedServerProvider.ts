import type { ServerProvider } from "contracts";
import { Duration, Effect, PubSub, Ref, Scope, Stream } from "effect";
import * as Semaphore from "effect/Semaphore";

import type { ServerProviderShape } from "./Services/ServerProvider";
import { ServerSettingsError } from "contracts";

const DEFAULT_REFRESH_INTERVAL = "60 seconds";
const DEFAULT_UNHEALTHY_REFRESH_INTERVAL = "5 minutes";

function refreshIntervalForSnapshot(
  snapshot: ServerProvider,
  input: {
    readonly refreshInterval?: Duration.Input;
    readonly unhealthyRefreshInterval?: Duration.Input;
  },
): Duration.Input {
  return snapshot.status === "ready"
    ? (input.refreshInterval ?? DEFAULT_REFRESH_INTERVAL)
    : (input.unhealthyRefreshInterval ?? DEFAULT_UNHEALTHY_REFRESH_INTERVAL);
}

export const makeManagedServerProvider = Effect.fn("makeManagedServerProvider")(function* <
  Settings extends { readonly enabled: boolean },
>(input: {
  readonly getSettings: Effect.Effect<Settings>;
  readonly streamSettings: Stream.Stream<Settings>;
  readonly haveSettingsChanged: (previous: Settings, next: Settings) => boolean;
  readonly checkProvider: Effect.Effect<ServerProvider, ServerSettingsError>;
  readonly buildInitialSnapshot: (settings: Settings) => ServerProvider;
  readonly refreshInterval?: Duration.Input;
  readonly unhealthyRefreshInterval?: Duration.Input;
}): Effect.fn.Return<ServerProviderShape, ServerSettingsError, Scope.Scope> {
  const refreshSemaphore = yield* Semaphore.make(1);
  const changesPubSub = yield* Effect.acquireRelease(
    PubSub.unbounded<ServerProvider>(),
    PubSub.shutdown,
  );
  const initialSettings = yield* input.getSettings;
  const initialSnapshot = input.buildInitialSnapshot(initialSettings);
  const snapshotRef = yield* Ref.make(initialSnapshot);
  const settingsRef = yield* Ref.make(initialSettings);
  const publishSnapshot = Effect.fn("publishSnapshot")(function* (nextSnapshot: ServerProvider) {
    yield* Ref.set(snapshotRef, nextSnapshot);
    yield* PubSub.publish(changesPubSub, nextSnapshot);
    return nextSnapshot;
  });

  const applyDisabledSnapshot = Effect.fn("applyDisabledSnapshot")(function* (
    nextSettings: Settings,
  ) {
    const nextSnapshot = input.buildInitialSnapshot(nextSettings);
    yield* Ref.set(settingsRef, nextSettings);
    return yield* publishSnapshot(nextSnapshot);
  });

  const applySnapshotBase = Effect.fn("applySnapshot")(function* (
    nextSettings: Settings,
    options?: { readonly forceRefresh?: boolean },
  ) {
    const forceRefresh = options?.forceRefresh === true;
    const previousSettings = yield* Ref.get(settingsRef);
    if (!nextSettings.enabled) {
      if (!input.haveSettingsChanged(previousSettings, nextSettings)) {
        yield* Ref.set(settingsRef, nextSettings);
        return yield* Ref.get(snapshotRef);
      }
      return yield* applyDisabledSnapshot(nextSettings);
    }

    if (!forceRefresh && !input.haveSettingsChanged(previousSettings, nextSettings)) {
      yield* Ref.set(settingsRef, nextSettings);
      return yield* Ref.get(snapshotRef);
    }

    yield* Ref.set(settingsRef, nextSettings);
    const nextSnapshot = yield* input.checkProvider;
    const currentSettings = yield* Ref.get(settingsRef);
    if (input.haveSettingsChanged(currentSettings, nextSettings)) {
      return yield* Ref.get(snapshotRef);
    }

    return yield* publishSnapshot(nextSnapshot);
  });
  const applySnapshot = (nextSettings: Settings, options?: { readonly forceRefresh?: boolean }) =>
    Effect.gen(function* () {
      const forceRefresh = options?.forceRefresh === true;
      if (!nextSettings.enabled) {
        return yield* applySnapshotBase(nextSettings, options);
      }

      if (!forceRefresh) {
        const previousSettings = yield* Ref.get(settingsRef);
        if (!input.haveSettingsChanged(previousSettings, nextSettings)) {
          yield* Ref.set(settingsRef, nextSettings);
          return yield* Ref.get(snapshotRef);
        }
      }

      return yield* refreshSemaphore.withPermits(1)(applySnapshotBase(nextSettings, options));
    });

  const refreshSnapshot = Effect.fn("refreshSnapshot")(function* () {
    const nextSettings = yield* input.getSettings;
    return yield* applySnapshot(nextSettings, { forceRefresh: true });
  });

  yield* Stream.runForEach(input.streamSettings, (nextSettings) =>
    Effect.asVoid(applySnapshot(nextSettings)),
  ).pipe(Effect.forkScoped);

  const backgroundRefreshDelay = Ref.get(snapshotRef).pipe(
    Effect.map((snapshot) => refreshIntervalForSnapshot(snapshot, input)),
  );

  yield* Effect.forever(
    backgroundRefreshDelay.pipe(
      Effect.flatMap((delay) => Effect.sleep(delay)),
      Effect.flatMap(() => refreshSnapshot()),
      Effect.ignoreCause({ log: true }),
    ),
  ).pipe(Effect.forkScoped);

  if (initialSettings.enabled) {
    yield* refreshSnapshot().pipe(Effect.ignoreCause({ log: true }), Effect.forkScoped);
  }

  return {
    getSnapshot: input.getSettings.pipe(
      Effect.flatMap(applySnapshot),
      Effect.tapError(Effect.logError),
      Effect.orDie,
    ),
    refresh: refreshSnapshot().pipe(Effect.tapError(Effect.logError), Effect.orDie),
    get streamChanges() {
      return Stream.fromPubSub(changesPubSub);
    },
  } satisfies ServerProviderShape;
});
