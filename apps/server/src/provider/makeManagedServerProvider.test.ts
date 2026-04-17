import { assert, it } from "@effect/vitest";
import type { ServerProvider } from "contracts";
import { Deferred, Effect, Option, Stream } from "effect";

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

it.effect("returns the cached initial snapshot while the first refresh is still running", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const checkStarted = yield* Deferred.make<void, never>();
      const releaseCheck = yield* Deferred.make<void, never>();

      const provider = yield* makeManagedServerProvider({
        getSettings: Effect.succeed({ enabled: true }),
        streamSettings: Stream.empty,
        haveSettingsChanged: () => false,
        buildInitialSnapshot: () => pendingSnapshot,
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
