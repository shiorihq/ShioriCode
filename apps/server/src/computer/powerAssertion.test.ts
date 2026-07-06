import type { ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createPowerAssertion } from "./powerAssertion";

class FakeCaffeinate extends EventEmitter {
  killed = false;
  exitCode: number | null = null;
  kill(): boolean {
    this.killed = true;
    this.exitCode = 0;
    this.emit("exit");
    return true;
  }
}

function trackingSpawner(spawned: FakeCaffeinate[]): () => ChildProcess {
  return () => {
    const child = new FakeCaffeinate();
    spawned.push(child);
    return child as unknown as ChildProcess;
  };
}

describe("createPowerAssertion", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("spawns caffeinate once on keepAwake and reuses it while active", () => {
    const spawned: FakeCaffeinate[] = [];
    const assertion = createPowerAssertion({
      idleReleaseMs: 1_000,
      spawnCaffeinate: trackingSpawner(spawned),
    });

    assertion.keepAwake();
    assertion.keepAwake();
    expect(spawned).toHaveLength(1);
    expect(spawned[0]?.killed).toBe(false);
  });

  it("releases caffeinate after the idle window elapses", () => {
    const spawned: FakeCaffeinate[] = [];
    const assertion = createPowerAssertion({
      idleReleaseMs: 1_000,
      spawnCaffeinate: trackingSpawner(spawned),
    });

    assertion.keepAwake();
    vi.advanceTimersByTime(1_001);
    expect(spawned[0]?.killed).toBe(true);
  });

  it("refreshing before the idle window extends the assertion", () => {
    const spawned: FakeCaffeinate[] = [];
    const assertion = createPowerAssertion({
      idleReleaseMs: 1_000,
      spawnCaffeinate: trackingSpawner(spawned),
    });

    assertion.keepAwake();
    vi.advanceTimersByTime(800);
    assertion.keepAwake();
    vi.advanceTimersByTime(800);
    expect(spawned[0]?.killed).toBe(false);
    vi.advanceTimersByTime(300);
    expect(spawned[0]?.killed).toBe(true);
  });

  it("release stops caffeinate immediately", () => {
    const spawned: FakeCaffeinate[] = [];
    const assertion = createPowerAssertion({
      idleReleaseMs: 10_000,
      spawnCaffeinate: trackingSpawner(spawned),
    });

    assertion.keepAwake();
    assertion.release();
    expect(spawned[0]?.killed).toBe(true);
  });

  it("is a no-op when caffeinate is unavailable", () => {
    const assertion = createPowerAssertion({
      idleReleaseMs: 1_000,
      spawnCaffeinate: () => null,
    });
    expect(() => {
      assertion.keepAwake();
      vi.advanceTimersByTime(2_000);
      assertion.release();
    }).not.toThrow();
  });
});
