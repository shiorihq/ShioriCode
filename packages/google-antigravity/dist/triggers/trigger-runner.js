import { TriggerContext } from "./triggers.js";
export class TriggerRunner {
    #triggers;
    #connection;
    #controllers = [];
    #tasks = [];
    constructor(initOrTriggers, connection) {
        const init = Array.isArray(initOrTriggers)
            ? { triggers: initOrTriggers, connection }
            : initOrTriggers;
        if (!init.connection) {
            throw new Error("TriggerRunner connection is required.");
        }
        this.#triggers = [...init.triggers];
        this.#connection = init.connection;
    }
    static async start(init) {
        const runner = new TriggerRunner(init);
        await runner.start();
        return runner;
    }
    static async using(init, callback) {
        const runner = await TriggerRunner.start(init);
        try {
            return await callback(runner);
        }
        finally {
            await runner.stop();
        }
    }
    async start() {
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
    async stop() {
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
    get isRunning() {
        return this.#tasks.some((task) => !task.done);
    }
    get is_running() {
        return this.isRunning;
    }
    async [Symbol.asyncDispose]() {
        await this.stop();
    }
}
//# sourceMappingURL=trigger-runner.js.map