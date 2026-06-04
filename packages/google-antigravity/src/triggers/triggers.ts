import { Connection } from "../connections/connection.js";
import { AntigravityValidationError } from "../types.js";

export class TriggerContext {
  #connection: Connection;
  readonly signal: AbortSignal;

  constructor(connection: Connection, signal: AbortSignal = new AbortController().signal) {
    this.#connection = connection;
    this.signal = signal;
  }

  send(content: string): Promise<void> {
    return this.#connection.sendTriggerNotification(content);
  }
}

export type Trigger = (ctx: TriggerContext) => Promise<void>;

export function trigger(fn: Trigger): Trigger {
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
