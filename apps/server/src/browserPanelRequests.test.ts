import assert from "node:assert/strict";
import { describe, expect, it } from "vitest";
import { Effect, Fiber, Option, Stream } from "effect";

import { BrowserPanelRequests, BrowserPanelRequestsLive } from "./browserPanelRequests.ts";

async function runWithBrowserPanelRequests<A, E>(
  effect: Effect.Effect<A, E, BrowserPanelRequests>,
): Promise<A> {
  return await Effect.runPromise(effect.pipe(Effect.provide(BrowserPanelRequestsLive)));
}

describe("BrowserPanelRequests", () => {
  it("publishes legacy navigate requests as typed browser commands", async () => {
    await runWithBrowserPanelRequests(
      Effect.scoped(
        Effect.gen(function* () {
          const browserPanelRequests = yield* BrowserPanelRequests;
          const nextCommandFiber = yield* Stream.runHead(browserPanelRequests.stream).pipe(
            Effect.forkScoped,
          );

          yield* Effect.sleep("1 millis");
          yield* browserPanelRequests.publishNavigate({
            id: "browser-request-1",
            threadId: "thread-1" as never,
            url: "https://example.com",
          });

          const nextCommand = yield* Fiber.join(nextCommandFiber);
          assert.deepEqual(Option.getOrThrow(nextCommand), {
            id: "browser-request-1",
            threadId: "thread-1",
            type: "navigate",
            url: "https://example.com",
          });
        }),
      ),
    );
  });

  it("runs a browser command and resolves it from the matching result", async () => {
    await runWithBrowserPanelRequests(
      Effect.scoped(
        Effect.gen(function* () {
          const browserPanelRequests = yield* BrowserPanelRequests;
          const command = {
            id: "browser-command-1",
            threadId: "thread-1" as never,
            type: "evaluate" as const,
            script: "document.title",
            awaitPromise: true,
          };

          const emittedFiber = yield* Stream.runHead(browserPanelRequests.stream).pipe(
            Effect.forkScoped,
          );
          yield* Effect.sleep("1 millis");
          const resultFiber = yield* browserPanelRequests
            .runCommand(command, { timeoutMs: 1000 })
            .pipe(Effect.forkScoped);
          const emitted = yield* Fiber.join(emittedFiber);
          assert.deepEqual(Option.getOrThrow(emitted), command);

          yield* browserPanelRequests.completeCommand({
            id: command.id,
            threadId: command.threadId,
            ok: true,
            value: { title: "Example" },
          });

          const result = yield* Fiber.join(resultFiber);
          assert.deepEqual(result, {
            id: command.id,
            threadId: command.threadId,
            ok: true,
            value: { title: "Example" },
          });
        }),
      ),
    );
  });

  it("ignores unrelated command completions and times out unresolved commands", async () => {
    const result = await runWithBrowserPanelRequests(
      Effect.gen(function* () {
        const browserPanelRequests = yield* BrowserPanelRequests;
        const resultFiber = yield* browserPanelRequests
          .runCommand(
            {
              id: "browser-command-timeout",
              threadId: "thread-1" as never,
              type: "snapshot",
            },
            { timeoutMs: 20 },
          )
          .pipe(Effect.forkScoped);

        yield* browserPanelRequests.completeCommand({
          id: "different-command",
          threadId: "thread-1" as never,
          ok: true,
          value: "ignored",
        });

        return yield* Fiber.join(resultFiber);
      }).pipe(Effect.scoped),
    );

    expect(result).toMatchObject({
      id: "browser-command-timeout",
      ok: false,
    });
    expect(result.error).toContain("Timed out");
  });
});
