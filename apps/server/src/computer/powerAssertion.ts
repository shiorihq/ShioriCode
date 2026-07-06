import { type ChildProcess, spawn } from "node:child_process";

/**
 * Keeps the Mac awake for the duration of a Computer Use burst.
 *
 * Each individual desktop action runs in a short-lived helper process, so an
 * IOKit power assertion held inside the helper would evaporate the moment the
 * action returns and do nothing to stop the machine sleeping between steps of a
 * multi-step task. Instead the long-lived MCP server process holds the
 * assertion: it is refreshed on every action and released after an idle period,
 * so the display and system stay awake while the agent is actively driving the
 * desktop and sleep is allowed to resume once it stops.
 *
 * Implemented with `caffeinate(8)` rather than a native binding so it needs no
 * Swift/helper build and degrades to a no-op on non-macOS or if caffeinate is
 * unavailable. `-d` prevents display sleep (screenshots go black on a slept
 * display), `-i` idle system sleep, `-m` disk idle sleep, `-s` system sleep on
 * AC power — the full set a background desktop session depends on.
 */
export interface PowerAssertion {
  /** Acquire or refresh the assertion, extending the idle release timer. */
  readonly keepAwake: () => void;
  /** Release immediately (e.g. on MCP server shutdown). */
  readonly release: () => void;
}

const DEFAULT_IDLE_RELEASE_MS = 120_000;

export interface PowerAssertionOptions {
  readonly idleReleaseMs?: number;
  readonly reason?: string;
  /** Injectable spawner + platform for tests; defaults to real caffeinate. */
  readonly spawnCaffeinate?: (reason: string) => ChildProcess | null;
}

function defaultSpawnCaffeinate(reason: string): ChildProcess | null {
  if (process.platform !== "darwin") return null;
  try {
    // No -t/-w: caffeinate holds the assertion until we terminate it, so the
    // idle-release timer (not caffeinate) controls its lifetime.
    const child = spawn("caffeinate", ["-dims"], { stdio: "ignore" });
    child.on("error", () => {
      // caffeinate missing or blocked — treat as best-effort no-op.
    });
    void reason;
    return child;
  } catch {
    return null;
  }
}

export function createPowerAssertion(options: PowerAssertionOptions = {}): PowerAssertion {
  const idleReleaseMs = options.idleReleaseMs ?? DEFAULT_IDLE_RELEASE_MS;
  const reason = options.reason ?? "ShioriCode Computer Use";
  const spawnCaffeinate = options.spawnCaffeinate ?? defaultSpawnCaffeinate;

  let child: ChildProcess | null = null;
  let idleTimer: ReturnType<typeof setTimeout> | null = null;

  const stopChild = (): void => {
    if (child) {
      try {
        child.kill("SIGTERM");
      } catch {
        // Already gone.
      }
      child = null;
    }
  };

  const clearIdleTimer = (): void => {
    if (idleTimer) {
      clearTimeout(idleTimer);
      idleTimer = null;
    }
  };

  const release = (): void => {
    clearIdleTimer();
    stopChild();
  };

  const keepAwake = (): void => {
    if (!child) {
      child = spawnCaffeinate(reason);
      if (child) {
        child.once("exit", () => {
          if (child && child.exitCode !== null) child = null;
        });
      }
    }
    clearIdleTimer();
    idleTimer = setTimeout(release, idleReleaseMs);
    // Do not keep the event loop alive solely for the idle timer.
    if (typeof idleTimer.unref === "function") idleTimer.unref();
  };

  return { keepAwake, release };
}
