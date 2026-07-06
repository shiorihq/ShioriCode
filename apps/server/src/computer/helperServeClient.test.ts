import type { ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";

import { HelperServeClient, HelperServeUnsupportedError } from "./helperServeClient";

class FakeHelperProcess extends EventEmitter {
  readonly stdin = new PassThrough();
  readonly stdout = new PassThrough();
  killed = false;

  private readonly receivedLines: Array<Record<string, unknown>> = [];
  private buffer = "";
  private lineWaiters: Array<() => void> = [];

  constructor() {
    super();
    this.stdin.setEncoding("utf8");
    // Collect request lines with a persistent handler; consuming the stream
    // with an async iterator would destroy it when the loop exits.
    this.stdin.on("data", (chunk: string) => {
      this.buffer += chunk;
      let index = this.buffer.indexOf("\n");
      while (index >= 0) {
        const line = this.buffer.slice(0, index).trim();
        this.buffer = this.buffer.slice(index + 1);
        if (line) this.receivedLines.push(JSON.parse(line) as Record<string, unknown>);
        index = this.buffer.indexOf("\n");
      }
      const waiters = this.lineWaiters;
      this.lineWaiters = [];
      for (const waiter of waiters) waiter();
    });
  }

  kill(): boolean {
    this.killed = true;
    this.emit("exit", 0, null);
    return true;
  }

  ready(): void {
    this.stdout.write(
      `${JSON.stringify({ event: "ready", protocol: "shiori-computer-use-serve/1" })}\n`,
    );
  }

  respond(message: Record<string, unknown>): void {
    this.stdout.write(`${JSON.stringify(message)}\n`);
  }

  async requestLines(count: number): Promise<Array<Record<string, unknown>>> {
    while (this.receivedLines.length < count) {
      await new Promise<void>((resolve) => {
        this.lineWaiters.push(resolve);
      });
    }
    return this.receivedLines.splice(0, count);
  }
}

function makeClient(options?: {
  readyTimeoutMs?: number;
  requestTimeoutMs?: number;
  idleShutdownMs?: number;
}): { client: HelperServeClient; spawned: FakeHelperProcess[] } {
  const spawned: FakeHelperProcess[] = [];
  const client = new HelperServeClient({
    resolveHelperPath: () => "/fake/helper",
    readyTimeoutMs: options?.readyTimeoutMs ?? 500,
    requestTimeoutMs: options?.requestTimeoutMs ?? 500,
    idleShutdownMs: options?.idleShutdownMs ?? 60_000,
    spawnHelper: () => {
      const child = new FakeHelperProcess();
      spawned.push(child);
      return child as unknown as ChildProcess;
    },
  });
  return { client, spawned };
}

describe("HelperServeClient", () => {
  it("round-trips a request after the ready banner", async () => {
    const { client, spawned } = makeClient();
    const resultPromise = client.request("bcu-list-apps", {});
    expect(spawned).toHaveLength(1);
    const child = spawned[0]!;
    child.ready();
    const [request] = await child.requestLines(1);
    expect(request).toMatchObject({ id: 1, command: "bcu-list-apps", input: {} });
    child.respond({ id: 1, ok: true, result: { runningApps: [] } });
    await expect(resultPromise).resolves.toEqual({ runningApps: [] });
  });

  it("correlates out-of-order responses by id", async () => {
    const { client, spawned } = makeClient();
    const first = client.request("bcu-get-window-state", { app: "A" });
    const child = spawned[0]!;
    child.ready();
    await child.requestLines(1);
    const second = client.request("bcu-click", { app: "B" });
    await child.requestLines(1);
    child.respond({ id: 2, ok: true, result: { action: "click" } });
    child.respond({ id: 1, ok: true, result: { action: "state" } });
    await expect(second).resolves.toEqual({ action: "click" });
    await expect(first).resolves.toEqual({ action: "state" });
  });

  it("surfaces helper error envelopes as thrown errors", async () => {
    const { client, spawned } = makeClient();
    const resultPromise = client.request("bcu-click", {});
    const child = spawned[0]!;
    child.ready();
    await child.requestLines(1);
    child.respond({ id: 1, ok: false, code: "actionFailed", error: "No targetable window." });
    await expect(resultPromise).rejects.toThrow("No targetable window.");
  });

  it("marks serve unsupported when the helper exits before ready and does not respawn", async () => {
    const { client, spawned } = makeClient();
    const resultPromise = client.request("bcu-list-apps", {});
    spawned[0]!.emit("exit", 1, null);
    await expect(resultPromise).rejects.toBeInstanceOf(HelperServeUnsupportedError);
    await expect(client.request("bcu-list-apps", {})).rejects.toBeInstanceOf(
      HelperServeUnsupportedError,
    );
    expect(spawned).toHaveLength(1);
  });

  it("marks serve unsupported when the ready banner never arrives", async () => {
    const { client, spawned } = makeClient({ readyTimeoutMs: 50 });
    const resultPromise = client.request("bcu-list-apps", {});
    await expect(resultPromise).rejects.toBeInstanceOf(HelperServeUnsupportedError);
    expect(spawned).toHaveLength(1);
    expect(spawned[0]!.killed).toBe(false);
  });

  it("rejects in-flight requests and respawns after a crash", async () => {
    const { client, spawned } = makeClient();
    const first = client.request("bcu-get-window-state", { app: "A" });
    const child = spawned[0]!;
    child.ready();
    await child.requestLines(1);
    child.emit("exit", 1, null);
    await expect(first).rejects.toThrow("exited");

    const second = client.request("bcu-list-apps", {});
    expect(spawned).toHaveLength(2);
    const respawned = spawned[1]!;
    respawned.ready();
    const [request] = await respawned.requestLines(1);
    respawned.respond({ id: request?.id as number, ok: true, result: { runningApps: [] } });
    await expect(second).resolves.toEqual({ runningApps: [] });
  });

  it("times out hung requests and recycles the helper", async () => {
    const { client, spawned } = makeClient({ requestTimeoutMs: 50 });
    const resultPromise = client.request("bcu-click", {});
    const child = spawned[0]!;
    child.ready();
    await child.requestLines(1);
    await expect(resultPromise).rejects.toThrow("timed out after 50ms");

    const second = client.request("bcu-list-apps", {});
    expect(spawned).toHaveLength(2);
    const respawned = spawned[1]!;
    respawned.ready();
    const [request] = await respawned.requestLines(1);
    respawned.respond({ id: request?.id as number, ok: true, result: {} });
    await expect(second).resolves.toEqual({});
  });

  it("dispose stops the helper", async () => {
    const { client, spawned } = makeClient();
    const resultPromise = client.request("bcu-list-apps", {});
    const child = spawned[0]!;
    child.ready();
    await child.requestLines(1);
    child.respond({ id: 1, ok: true, result: {} });
    await resultPromise;
    client.dispose();
    // stdin EOF is the graceful shutdown signal.
    expect(child.stdin.writableEnded).toBe(true);
  });
});
