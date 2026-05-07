export type OrchestrationRecoveryReason =
  | "bootstrap"
  | "sequence-gap"
  | "replay-failed"
  | "stale-running-thread";

export interface OrchestrationRecoveryPhase {
  kind: "snapshot" | "replay";
  reason: OrchestrationRecoveryReason;
}

export interface OrchestrationRecoveryState {
  latestSequence: number;
  highestObservedSequence: number;
  bootstrapped: boolean;
  pendingReplay: boolean;
  inFlight: OrchestrationRecoveryPhase | null;
}

type SequencedEvent = Readonly<{ sequence: number }>;
type RecoverableThreadActivity = Readonly<{
  session:
    | Readonly<{
        status: string;
        activeTurnId?: unknown;
      }>
    | null
    | undefined;
}>;

export function hasPendingOrRunningThreadActivity(input: {
  readonly threads: ReadonlyArray<RecoverableThreadActivity>;
  readonly pendingThreadDispatchById: Readonly<Record<string, unknown>>;
}): boolean {
  if (Object.values(input.pendingThreadDispatchById).some((entry) => entry !== undefined)) {
    return true;
  }

  return input.threads.some((thread) => {
    const session = thread.session;
    return (
      session?.status === "running" &&
      session.activeTurnId !== undefined &&
      session.activeTurnId !== null
    );
  });
}

export function shouldRecoverStaleRunningOrchestration(input: {
  readonly now: number;
  readonly lastActivityAt: number;
  readonly staleAfterMs: number;
  readonly threads: ReadonlyArray<RecoverableThreadActivity>;
  readonly pendingThreadDispatchById: Readonly<Record<string, unknown>>;
}): boolean {
  return (
    hasPendingOrRunningThreadActivity({
      threads: input.threads,
      pendingThreadDispatchById: input.pendingThreadDispatchById,
    }) && input.now - input.lastActivityAt >= input.staleAfterMs
  );
}

export function createOrchestrationRecoveryCoordinator() {
  let state: OrchestrationRecoveryState = {
    latestSequence: 0,
    highestObservedSequence: 0,
    bootstrapped: false,
    pendingReplay: false,
    inFlight: null,
  };
  let replayStartSequence: number | null = null;

  const snapshotState = (): OrchestrationRecoveryState => ({
    ...state,
    ...(state.inFlight ? { inFlight: { ...state.inFlight } } : {}),
  });

  const observeSequence = (sequence: number) => {
    state.highestObservedSequence = Math.max(state.highestObservedSequence, sequence);
  };

  const resolveReplayNeedAfterRecovery = () => {
    const pendingReplayBeforeReset = state.pendingReplay;
    const observedAhead = state.highestObservedSequence > state.latestSequence;
    const shouldReplay = pendingReplayBeforeReset || observedAhead;
    state.pendingReplay = false;
    return {
      shouldReplay,
      pendingReplayBeforeReset,
      observedAhead,
    };
  };

  const selectApplicableEventBatch = <T extends SequencedEvent>(
    events: ReadonlyArray<T>,
  ): ReadonlyArray<T> =>
    events
      .filter((event) => event.sequence > state.latestSequence)
      .toSorted((left, right) => left.sequence - right.sequence);

  return {
    getState(): OrchestrationRecoveryState {
      return snapshotState();
    },

    shouldApplySnapshot(snapshotSequence: number): boolean {
      return snapshotSequence >= state.latestSequence;
    },

    classifyDomainEvent(sequence: number): "ignore" | "defer" | "recover" | "apply" {
      observeSequence(sequence);
      if (sequence <= state.latestSequence) {
        return "ignore";
      }
      if (!state.bootstrapped || state.inFlight) {
        state.pendingReplay = true;
        return "defer";
      }
      if (sequence !== state.latestSequence + 1) {
        state.pendingReplay = true;
        return "recover";
      }
      return "apply";
    },

    selectApplicableEventBatch<T extends SequencedEvent>(
      events: ReadonlyArray<T>,
    ): ReadonlyArray<T> {
      return selectApplicableEventBatch(events);
    },

    markEventBatchApplied<T extends SequencedEvent>(events: ReadonlyArray<T>): ReadonlyArray<T> {
      const nextEvents = selectApplicableEventBatch(events);
      if (nextEvents.length === 0) {
        return [];
      }

      state.latestSequence = nextEvents.at(-1)?.sequence ?? state.latestSequence;
      state.highestObservedSequence = Math.max(state.highestObservedSequence, state.latestSequence);
      return nextEvents;
    },

    beginSnapshotRecovery(reason: OrchestrationRecoveryReason): boolean {
      if (state.inFlight?.kind === "snapshot") {
        state.pendingReplay = true;
        return false;
      }
      if (state.inFlight?.kind === "replay") {
        state.pendingReplay = true;
        return false;
      }
      state.inFlight = { kind: "snapshot", reason };
      return true;
    },

    completeSnapshotRecovery(snapshotSequence: number): boolean {
      state.latestSequence = Math.max(state.latestSequence, snapshotSequence);
      state.highestObservedSequence = Math.max(state.highestObservedSequence, state.latestSequence);
      state.bootstrapped = true;
      state.inFlight = null;
      return resolveReplayNeedAfterRecovery().shouldReplay;
    },

    failSnapshotRecovery(): void {
      state.inFlight = null;
    },

    beginReplayRecovery(reason: OrchestrationRecoveryReason): boolean {
      if (!state.bootstrapped || state.inFlight?.kind === "snapshot") {
        state.pendingReplay = true;
        return false;
      }
      if (state.inFlight?.kind === "replay") {
        state.pendingReplay = true;
        return false;
      }
      state.pendingReplay = false;
      replayStartSequence = state.latestSequence;
      state.inFlight = { kind: "replay", reason };
      return true;
    },

    completeReplayRecovery(): boolean {
      const replayMadeProgress =
        replayStartSequence !== null && state.latestSequence > replayStartSequence;
      replayStartSequence = null;
      state.inFlight = null;
      if (!replayMadeProgress) {
        state.pendingReplay = false;
        return false;
      }
      return resolveReplayNeedAfterRecovery().shouldReplay;
    },

    failReplayRecovery(): void {
      replayStartSequence = null;
      state.bootstrapped = false;
      state.inFlight = null;
    },
  };
}
