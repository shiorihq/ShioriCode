import { type ChildProcess, spawn } from "node:child_process";
import readline from "node:readline";

/**
 * Client for the Computer Use helper's persistent `serve` mode.
 *
 * The helper historically ran as one process per action, which meant a cold
 * Accessibility runtime for every click/screenshot and no state continuity
 * between them. Serve mode keeps a single helper process alive and speaks a
 * JSON-lines protocol over stdio:
 *
 *   helper -> {"event":"ready","protocol":"shiori-computer-use-serve/1"}
 *   client -> {"id":1,"command":"bcu-get-window-state","input":{...}}
 *   helper -> {"id":1,"ok":true,"result":{...}}
 *   helper -> {"id":2,"ok":false,"code":"actionFailed","error":"..."}
 *
 * An older helper binary does not understand `serve` (it waits for stdin EOF
 * and errors), so readiness is detected via the banner with a timeout; on any
 * readiness failure the client marks serve mode unsupported for the rest of
 * the process and throws HelperServeUnsupportedError so the caller can fall
 * back to one-shot spawning. The child is shut down after an idle period and
 * respawned transparently on the next request.
 */
export class HelperServeUnsupportedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "HelperServeUnsupportedError";
  }
}

interface PendingRequest {
  readonly resolve: (value: unknown) => void;
  readonly reject: (error: Error) => void;
  readonly timer: ReturnType<typeof setTimeout>;
}

export interface HelperServeClientOptions {
  readonly resolveHelperPath: () => string;
  readonly requestTimeoutMs?: number;
  readonly readyTimeoutMs?: number;
  readonly idleShutdownMs?: number;
  /** Injectable spawner for tests; defaults to spawning the real helper. */
  readonly spawnHelper?: (helperPath: string) => ChildProcess;
}

const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;
const DEFAULT_READY_TIMEOUT_MS = 5_000;
const DEFAULT_IDLE_SHUTDOWN_MS = 5 * 60_000;

function defaultSpawnHelper(helperPath: string): ChildProcess {
  return spawn(helperPath, ["serve"], { stdio: ["pipe", "pipe", "ignore"] });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export class HelperServeClient {
  private readonly options: HelperServeClientOptions;
  private child: ChildProcess | null = null;
  private readyPromise: Promise<void> | null = null;
  private serveUnsupported = false;
  private nextRequestId = 0;
  private readonly pending = new Map<number, PendingRequest>();
  private idleTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(options: HelperServeClientOptions) {
    this.options = options;
  }

  async request(command: string, input: unknown): Promise<unknown> {
    await this.ensureReady();
    const child = this.child;
    if (!child?.stdin?.writable) {
      throw new Error("The Computer Use helper session is not writable.");
    }

    const id = ++this.nextRequestId;
    const timeoutMs = this.options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
    const result = new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        // A hung helper cannot serve later requests either; recycle it so the
        // next request starts from a healthy process.
        this.stopChild();
        reject(
          new Error(`Computer Use helper action '${command}' timed out after ${timeoutMs}ms.`),
        );
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
    });

    child.stdin.write(`${JSON.stringify({ id, command, input: input ?? {} })}\n`);
    this.scheduleIdleShutdown();
    return result;
  }

  dispose(): void {
    this.stopChild();
  }

  private async ensureReady(): Promise<void> {
    if (this.serveUnsupported) {
      throw new HelperServeUnsupportedError(
        "The Computer Use helper does not support persistent serve mode.",
      );
    }
    if (!this.readyPromise) {
      this.readyPromise = this.startChild();
    }
    try {
      await this.readyPromise;
    } catch (error) {
      this.readyPromise = null;
      throw error;
    }
  }

  private startChild(): Promise<void> {
    const helperPath = this.options.resolveHelperPath();
    const spawnHelper = this.options.spawnHelper ?? defaultSpawnHelper;
    const readyTimeoutMs = this.options.readyTimeoutMs ?? DEFAULT_READY_TIMEOUT_MS;

    return new Promise<void>((resolve, reject) => {
      let settledReady = false;
      const child = spawnHelper(helperPath);
      this.child = child;

      const failReady = (reason: string): void => {
        if (settledReady) return;
        settledReady = true;
        clearTimeout(readyTimer);
        // Any readiness failure is treated as "this binary cannot serve":
        // an old helper blocks on stdin EOF (timeout) or exits with an
        // unsupported-command error. Falling back to one-shot mode is always
        // safe, so prefer that over retry loops against the same binary.
        this.serveUnsupported = true;
        this.stopChild();
        reject(new HelperServeUnsupportedError(reason));
      };

      const readyTimer = setTimeout(() => {
        failReady(
          `The Computer Use helper did not enter serve mode within ${readyTimeoutMs}ms; falling back to one-shot actions.`,
        );
      }, readyTimeoutMs);

      if (!child.stdout) {
        failReady("The Computer Use helper serve process has no stdout.");
        return;
      }

      const lines = readline.createInterface({ input: child.stdout, crlfDelay: Infinity });
      lines.on("line", (line) => {
        const trimmed = line.trim();
        if (!trimmed) return;
        let message: unknown;
        try {
          message = JSON.parse(trimmed);
        } catch {
          return;
        }
        if (!isRecord(message)) return;
        if (message.event === "ready") {
          if (!settledReady) {
            settledReady = true;
            clearTimeout(readyTimer);
            resolve();
          }
          return;
        }
        this.handleResponse(message);
      });

      child.once("error", (error) => {
        failReady(`The Computer Use helper serve process failed to start: ${error.message}`);
        if (this.child === child) {
          this.handleChildGone("The Computer Use helper process failed.");
        }
      });

      child.once("exit", () => {
        if (!settledReady) {
          failReady("The Computer Use helper exited before entering serve mode.");
        }
        // Only tear down if this exit belongs to the current child; a stale
        // exit from an already-replaced process must not affect its successor.
        if (this.child === child) {
          this.handleChildGone("The Computer Use helper exited before responding.");
        }
      });
    });
  }

  private handleResponse(message: Record<string, unknown>): void {
    const id = typeof message.id === "number" ? message.id : null;
    if (id === null) return;
    const pending = this.pending.get(id);
    if (!pending) return;
    this.pending.delete(id);
    clearTimeout(pending.timer);
    if (message.ok === true) {
      pending.resolve(message.result ?? {});
      return;
    }
    const errorText =
      typeof message.error === "string" && message.error.trim()
        ? message.error.trim()
        : "Computer Use helper action failed.";
    pending.reject(new Error(errorText));
  }

  private handleChildGone(reason: string): void {
    this.child = null;
    this.readyPromise = null;
    this.clearIdleTimer();
    const pending = [...this.pending.values()];
    this.pending.clear();
    for (const request of pending) {
      clearTimeout(request.timer);
      request.reject(new Error(reason));
    }
  }

  private stopChild(): void {
    const child = this.child;
    this.child = null;
    this.readyPromise = null;
    this.clearIdleTimer();
    if (!child) return;
    // Closing stdin lets the helper exit cleanly on EOF; SIGTERM is a backstop.
    try {
      child.stdin?.end();
    } catch {
      // Stream already closed.
    }
    const killTimer = setTimeout(() => {
      try {
        child.kill("SIGTERM");
      } catch {
        // Already gone.
      }
    }, 1_000);
    if (typeof killTimer.unref === "function") killTimer.unref();
    child.once("exit", () => clearTimeout(killTimer));
  }

  private scheduleIdleShutdown(): void {
    this.clearIdleTimer();
    const idleShutdownMs = this.options.idleShutdownMs ?? DEFAULT_IDLE_SHUTDOWN_MS;
    this.idleTimer = setTimeout(() => {
      if (this.pending.size === 0) {
        this.stopChild();
      } else {
        this.scheduleIdleShutdown();
      }
    }, idleShutdownMs);
    if (typeof this.idleTimer.unref === "function") this.idleTimer.unref();
  }

  private clearIdleTimer(): void {
    if (this.idleTimer) {
      clearTimeout(this.idleTimer);
      this.idleTimer = null;
    }
  }
}
