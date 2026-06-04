import { Connection } from "../connections/connection.js";
import { Trigger, TriggerContext } from "./triggers.js";

type TriggerRunnerInit = { triggers: Trigger[]; connection: Connection };

export class TriggerRunner implements AsyncDisposable {
  #triggers: Trigger[];
  #connection: Connection;
  #controllers: AbortController[] = [];
  #tasks: Array<{ promise: Promise<void>; done: boolean }> = [];

  constructor(init: TriggerRunnerInit);
  constructor(triggers: Trigger[], connection: Connection);
  constructor(initOrTriggers: TriggerRunnerInit | Trigger[], connection?: Connection) {
    const init = Array.isArray(initOrTriggers)
      ? { triggers: initOrTriggers, connection }
      : initOrTriggers;
    if (!init.connection) {
      throw new Error("TriggerRunner connection is required.");
    }
    this.#triggers = [...init.triggers];
    this.#connection = init.connection;
  }

  static async start(init: TriggerRunnerInit): Promise<TriggerRunner> {
    const runner = new TriggerRunner(init);
    await runner.start();
    return runner;
  }

  static async using<T>(
    init: TriggerRunnerInit,
    callback: (runner: TriggerRunner) => T | Promise<T>,
  ): Promise<T> {
    const runner = await TriggerRunner.start(init);
    try {
      return await callback(runner);
    } finally {
      await runner.stop();
    }
  }

  async start(): Promise<void> {
    if (this.#tasks.length) {
      throw new Error("TriggerRunner is already started.");
    }
    for (const item of this.#triggers) {
      const controller = new AbortController();
      this.#controllers.push(controller);
      const ctx = new TriggerContext(this.#connection, controller.signal);
      const task = {
        done: false,
        promise: item(ctx).catch((error) => {
          if (!controller.signal.aborted) {
            console.error(`Trigger '${item.name || "unknown"}' failed`, error);
          }
        }),
      };
      task.promise = task.promise.finally(() => {
        task.done = true;
      });
      this.#tasks.push(task);
    }
  }

  async stop(): Promise<void> {
    if (!this.#tasks.length) {
      return;
    }
    for (const controller of this.#controllers) {
      controller.abort();
    }
    await Promise.race([
      Promise.allSettled(this.#tasks.map((task) => task.promise)),
      new Promise((resolve) => setTimeout(resolve, 50)),
    ]);
    this.#tasks = [];
    this.#controllers = [];
  }

  get isRunning(): boolean {
    return this.#tasks.some((task) => !task.done);
  }

  get is_running(): boolean {
    return this.isRunning;
  }

  async [Symbol.asyncDispose](): Promise<void> {
    await this.stop();
  }
}
