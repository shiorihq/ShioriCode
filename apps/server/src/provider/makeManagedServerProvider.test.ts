import { assert, it } from "@effect/vitest";
import type { ServerProvider } from "contracts";
import { Deferred, Effect, Option, PubSub, Ref, Stream } from "effect";
import { TestClock } from "effect/testing";

import { makeManagedServerProvider } from "./makeManagedServerProvider";

const pendingSnapshot: ServerProvider = {
  provider: "codex",
  enabled: true,
  installed: true,
  version: null,
  status: "warning",
  auth: { status: "unknown" },
  checkedAt: "2026-04-17T00:00:00.000Z",
  message: "Checking Codex CLI availability...",
  models: [],
};

const readySnapshot: ServerProvider = {
  ...pendingSnapshot,
  status: "ready",
  checkedAt: "2026-04-17T00:00:01.000Z",
  message: "Codex is ready.",
};

const disabledSnapshot: ServerProvider = {
  ...pendingSnapshot,
  enabled: false,
  installed: false,
  status: "disabled",
  checkedAt: "2026-04-17T00:00:02.000Z",
  message: "Codex is disabled in ShioriCode settings.",
};

function buildSnapshotForSettings(settings: { readonly enabled: boolean }): ServerProvider {
  return settings.enabled ? pendingSnapshot : disabledSnapshot;
}

it.effect("returns the cached initial snapshot while the first refresh is still running", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const checkStarted = yield* Deferred.make<void, never>();
      const releaseCheck = yield* Deferred.make<void, never>();

      const provider = yield* makeManagedServerProvider({
        getSettings: Effect.succeed({ enabled: true }),
        streamSettings: Stream.empty,
        haveSettingsChanged: () => false,
        buildInitialSnapshot: buildSnapshotForSettings,
        checkProvider: Effect.gen(function* () {
          yield* Deferred.succeed(checkStarted, undefined).pipe(Effect.orDie);
          yield* Deferred.await(releaseCheck);
          return readySnapshot;
        }),
      });

      yield* Deferred.await(checkStarted);

      const initial = yield* provider.getSnapshot.pipe(Effect.timeoutOption("50 millis"));
      const initialSnapshot = Option.match(initial, {
        onNone: () => {
          throw new Error("Expected the cached provider snapshot to resolve without blocking.");
        },
        onSome: (snapshot) => snapshot,
      });
      assert.strictEqual(initialSnapshot.status, "warning");
      assert.strictEqual(initialSnapshot.message, "Checking Codex CLI availability...");

      yield* Deferred.succeed(releaseCheck, undefined).pipe(Effect.orDie);

      for (let attempt = 0; attempt < 20; attempt += 1) {
        const snapshot = yield* provider.getSnapshot;
        if (snapshot.status === "ready") {
          assert.strictEqual(snapshot.message, "Codex is ready.");
          return;
        }
        yield* Effect.yieldNow;
      }

      const snapshot = yield* provider.getSnapshot;
      assert.strictEqual(snapshot.status, "ready");
      assert.strictEqual(snapshot.message, "Codex is ready.");
    }),
  ),
);

it.effect("backs off background refreshes while a provider is unhealthy", () =>
  Effect.scoped(
    Effect.gen(function* () {
      let checkCount = 0;

      yield* makeManagedServerProvider({
        getSettings: Effect.succeed({ enabled: true }),
        streamSettings: Stream.empty,
        haveSettingsChanged: () => false,
        buildInitialSnapshot: buildSnapshotForSettings,
        refreshInterval: "1 second",
        unhealthyRefreshInterval: "5 seconds",
        checkProvider: Effect.sync(() => {
          checkCount += 1;
          return pendingSnapshot;
        }),
      });

      yield* Effect.yieldNow;
      assert.strictEqual(checkCount, 1);

      yield* TestClock.adjust("1 second");
      yield* Effect.yieldNow;
      assert.strictEqual(checkCount, 1);

      yield* TestClock.adjust("4 seconds");
      yield* Effect.yieldNow;
      assert.strictEqual(checkCount, 2);
    }),
  ).pipe(Effect.provide(TestClock.layer())),
);

it.effect("does not check disabled providers until settings enable them again", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const settingsRef = yield* Ref.make({ enabled: false });
      const settingsPubSub = yield* PubSub.unbounded<{ readonly enabled: boolean }>();
      let checkCount = 0;

      const provider = yield* makeManagedServerProvider({
        getSettings: Ref.get(settingsRef),
        streamSettings: Stream.fromPubSub(settingsPubSub),
        haveSettingsChanged: (previous, next) => previous.enabled !== next.enabled,
        buildInitialSnapshot: buildSnapshotForSettings,
        refreshInterval: "1 second",
        unhealthyRefreshInterval: "1 second",
        checkProvider: Effect.sync(() => {
          checkCount += 1;
          return readySnapshot;
        }),
      });

      assert.strictEqual((yield* provider.getSnapshot).status, "disabled");
      assert.strictEqual(checkCount, 0);

      yield* provider.refresh;
      yield* TestClock.adjust("2 seconds");
      yield* Effect.yieldNow;
      assert.strictEqual(checkCount, 0);

      yield* Ref.set(settingsRef, { enabled: true });
      yield* PubSub.publish(settingsPubSub, { enabled: true });

      for (let attempt = 0; attempt < 20; attempt += 1) {
        const snapshot = yield* provider.getSnapshot;
        if (snapshot.status === "ready") {
          assert.strictEqual(checkCount, 1);
          return;
        }
        yield* Effect.yieldNow;
      }

      assert.strictEqual((yield* provider.getSnapshot).status, "ready");
      assert.strictEqual(checkCount, 1);
    }),
  ).pipe(Effect.provide(TestClock.layer())),
);
