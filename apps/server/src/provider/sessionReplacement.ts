import { Effect } from "effect";

/**
 * Publishes a provider session that has already crossed its startup/readiness
 * boundary. The previous runtime is retired only after the replacement is
 * usable, while the replacement stays unpublished until retirement completes.
 *
 * Callers must serialize replacements for the same thread and make `retire`
 * total (provider teardown should log/ignore cleanup failures that cannot be
 * recovered from). Keeping this contract in the harness prevents every
 * provider adapter from inventing a subtly different restart order.
 */
export const commitPreparedSessionReplacement = <Session, E, R>(input: {
  readonly replacement: Session;
  readonly readCurrent: Effect.Effect<Session | undefined>;
  readonly retire: (session: Session) => Effect.Effect<void, E, R>;
  readonly publish: (session: Session) => Effect.Effect<void>;
}): Effect.Effect<Session, E, R> =>
  Effect.gen(function* () {
    const current = yield* input.readCurrent;
    if (current !== undefined && current !== input.replacement) {
      yield* input.retire(current);
    }
    yield* input.publish(input.replacement);
    return input.replacement;
  });
