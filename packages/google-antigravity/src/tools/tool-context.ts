import { Connection } from "../connections/connection.js";

export class ToolContext {
  #connection: Connection;
  #state = new Map<string, unknown>();

  constructor(connection: Connection) {
    this.#connection = connection;
  }

  get conversationId(): string {
    return this.#connection.conversationId;
  }

  get conversation_id(): string {
    return this.conversationId;
  }

  get isIdle(): boolean {
    return this.#connection.isIdle;
  }

  get is_idle(): boolean {
    return this.isIdle;
  }

  send(message: string): Promise<void> {
    return this.#connection.sendTriggerNotification(message);
  }

  getState<T = unknown>(key: string, defaultValue?: T): T | undefined {
    return this.#state.has(key) ? (this.#state.get(key) as T) : defaultValue;
  }

  get_state<T = unknown>(key: string, defaultValue?: T): T | undefined {
    return this.getState(key, defaultValue);
  }

  setState(key: string, value: unknown): void {
    this.#state.set(key, value);
  }

  set_state(key: string, value: unknown): void {
    this.setState(key, value);
  }
}
