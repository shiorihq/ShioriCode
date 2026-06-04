import { AntigravityValidationError } from "../types.js";
export class TriggerContext {
    #connection;
    signal;
    constructor(connection, signal = new AbortController().signal) {
        this.#connection = connection;
        this.signal = signal;
    }
    send(content) {
        return this.#connection.sendTriggerNotification(content);
    }
}
export function trigger(fn) {
    if (fn.constructor.name !== "AsyncFunction") {
        throw new AntigravityValidationError("Trigger must be an async function");
    }
    if (fn.length !== 1) {
        throw new AntigravityValidationError("Trigger must accept exactly one parameter");
    }
    Object.defineProperty(fn, "__isTrigger__", {
        value: true,
        enumerable: false,
    });
    Object.defineProperty(fn, "__is_trigger__", {
        value: true,
        enumerable: false,
    });
    return fn;
}
//# sourceMappingURL=triggers.js.map