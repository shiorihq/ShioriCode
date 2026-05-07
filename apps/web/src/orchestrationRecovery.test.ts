import { describe, expect, it } from "vitest";

import {
  createOrchestrationRecoveryCoordinator,
  hasPendingOrRunningThreadActivity,
  shouldRecoverStaleRunningOrchestration,
} from "./orchestrationRecovery";

describe("createOrchestrationRecoveryCoordinator", () => {
  it("defers live events until bootstrap completes and then requests replay", () => {
    const coordinator = createOrchestrationRecoveryCoordinator();

    expect(coordinator.beginSnapshotRecovery("bootstrap")).toBe(true);
    expect(coordinator.classifyDomainEvent(4)).toBe("defer");

    expect(coordinator.completeSnapshotRecovery(2)).toBe(true);
    expect(coordinator.getState()).toMatchObject({
      latestSequence: 2,
      highestObservedSequence: 4,
      bootstrapped: true,
      pendingReplay: false,
      inFlight: null,
    });
  });

  it("classifies sequence gaps as recovery-only replay work", () => {
    const coordinator = createOrchestrationRecoveryCoordinator();

    coordinator.beginSnapshotRecovery("bootstrap");
    coordinator.completeSnapshotRecovery(3);

    expect(coordinator.classifyDomainEvent(5)).toBe("recover");
    expect(coordinator.beginReplayRecovery("sequence-gap")).toBe(true);
    expect(coordinator.getState().inFlight).toEqual({
      kind: "replay",
      reason: "sequence-gap",
    });
  });

  it("tracks live event batches without entering recovery", () => {
    const coordinator = createOrchestrationRecoveryCoordinator();

    coordinator.beginSnapshotRecovery("bootstrap");
    coordinator.completeSnapshotRecovery(3);

    expect(coordinator.classifyDomainEvent(4)).toBe("apply");
    expect(coordinator.markEventBatchApplied([{ sequence: 4 }])).toEqual([{ sequence: 4 }]);
    expect(coordinator.getState()).toMatchObject({
      latestSequence: 4,
      highestObservedSequence: 4,
      bootstrapped: true,
      inFlight: null,
    });
  });

  it("can select an applicable event batch without committing progress", () => {
    const coordinator = createOrchestrationRecoveryCoordinator();

    coordinator.beginSnapshotRecovery("bootstrap");
    coordinator.completeSnapshotRecovery(3);

    expect(coordinator.selectApplicableEventBatch([{ sequence: 2 }, { sequence: 5 }])).toEqual([
      { sequence: 5 },
    ]);
    expect(coordinator.getState().latestSequence).toBe(3);

    coordinator.markEventBatchApplied([{ sequence: 5 }]);
    expect(coordinator.getState().latestSequence).toBe(5);
  });

  it("rejects stale snapshots once newer live events were already applied", () => {
    const coordinator = createOrchestrationRecoveryCoordinator();

    coordinator.beginSnapshotRecovery("bootstrap");
    coordinator.completeSnapshotRecovery(3);
    expect(coordinator.classifyDomainEvent(4)).toBe("apply");
    coordinator.markEventBatchApplied([{ sequence: 4 }]);

    expect(coordinator.shouldApplySnapshot(3)).toBe(false);
    expect(coordinator.shouldApplySnapshot(4)).toBe(true);
    expect(coordinator.shouldApplySnapshot(5)).toBe(true);
  });

  it("requests another replay when deferred events arrive during replay recovery", () => {
    const coordinator = createOrchestrationRecoveryCoordinator();

    coordinator.beginSnapshotRecovery("bootstrap");
    coordinator.completeSnapshotRecovery(3);
    coordinator.classifyDomainEvent(5);
    coordinator.beginReplayRecovery("sequence-gap");
    coordinator.classifyDomainEvent(7);
    coordinator.markEventBatchApplied([{ sequence: 4 }, { sequence: 5 }, { sequence: 6 }]);

    expect(coordinator.completeReplayRecovery()).toBe(true);
  });

  it("does not immediately replay again when replay returns no new events", () => {
    const coordinator = createOrchestrationRecoveryCoordinator();

    coordinator.beginSnapshotRecovery("bootstrap");
    coordinator.completeSnapshotRecovery(3);
    coordinator.classifyDomainEvent(5);
    coordinator.beginReplayRecovery("sequence-gap");

    expect(coordinator.completeReplayRecovery()).toBe(false);
    expect(coordinator.getState()).toMatchObject({
      latestSequence: 3,
      highestObservedSequence: 5,
      pendingReplay: false,
      inFlight: null,
    });
  });

  it("marks replay failure as unbootstrapped so snapshot fallback is recovery-only", () => {
    const coordinator = createOrchestrationRecoveryCoordinator();

    coordinator.beginSnapshotRecovery("bootstrap");
    coordinator.completeSnapshotRecovery(3);
    coordinator.beginReplayRecovery("sequence-gap");
    coordinator.failReplayRecovery();

    expect(coordinator.getState()).toMatchObject({
      bootstrapped: false,
      inFlight: null,
    });
    expect(coordinator.beginSnapshotRecovery("replay-failed")).toBe(true);
    expect(coordinator.getState().inFlight).toEqual({
      kind: "snapshot",
      reason: "replay-failed",
    });
  });

  it("keeps enough state to explain why bootstrap snapshot recovery requests replay", () => {
    const coordinator = createOrchestrationRecoveryCoordinator();

    expect(coordinator.beginSnapshotRecovery("bootstrap")).toBe(true);
    expect(coordinator.classifyDomainEvent(4)).toBe("defer");
    expect(coordinator.completeSnapshotRecovery(2)).toBe(true);

    expect(coordinator.getState()).toMatchObject({
      latestSequence: 2,
      highestObservedSequence: 4,
      bootstrapped: true,
      pendingReplay: false,
      inFlight: null,
    });
  });

  it("reports skip state when snapshot recovery is requested while replay is in flight", () => {
    const coordinator = createOrchestrationRecoveryCoordinator();

    coordinator.beginSnapshotRecovery("bootstrap");
    coordinator.completeSnapshotRecovery(3);
    expect(coordinator.beginReplayRecovery("sequence-gap")).toBe(true);

    expect(coordinator.beginSnapshotRecovery("bootstrap")).toBe(false);
    expect(coordinator.getState()).toMatchObject({
      pendingReplay: true,
      inFlight: {
        kind: "replay",
        reason: "sequence-gap",
      },
    });
  });
});

describe("stale running orchestration recovery", () => {
  it("detects running sessions and pending dispatches as active work", () => {
    expect(
      hasPendingOrRunningThreadActivity({
        threads: [{ session: { status: "running", activeTurnId: "turn-1" } }],
        pendingThreadDispatchById: {},
      }),
    ).toBe(true);
    expect(
      hasPendingOrRunningThreadActivity({
        threads: [{ session: { status: "ready", activeTurnId: undefined } }],
        pendingThreadDispatchById: { "thread-1": { commandId: "cmd-1" } },
      }),
    ).toBe(true);
    expect(
      hasPendingOrRunningThreadActivity({
        threads: [{ session: { status: "running", activeTurnId: null } }],
        pendingThreadDispatchById: {},
      }),
    ).toBe(false);
  });

  it("requests snapshot recovery only after active work goes stale", () => {
    expect(
      shouldRecoverStaleRunningOrchestration({
        now: 20_000,
        lastActivityAt: 4_000,
        staleAfterMs: 15_000,
        threads: [{ session: { status: "running", activeTurnId: "turn-1" } }],
        pendingThreadDispatchById: {},
      }),
    ).toBe(true);
    expect(
      shouldRecoverStaleRunningOrchestration({
        now: 10_000,
        lastActivityAt: 4_000,
        staleAfterMs: 15_000,
        threads: [{ session: { status: "running", activeTurnId: "turn-1" } }],
        pendingThreadDispatchById: {},
      }),
    ).toBe(false);
  });
});
