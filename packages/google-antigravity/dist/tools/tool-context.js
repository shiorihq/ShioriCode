export class ToolContext {
    #connection;
    #state = new Map();
    constructor(connection) {
        this.#connection = connection;
    }
    get conversationId() {
        return this.#connection.conversationId;
    }
    get conversation_id() {
        return this.conversationId;
    }
    get isIdle() {
        return this.#connection.isIdle;
    }
    get is_idle() {
        return this.isIdle;
    }
    send(message) {
        return this.#connection.sendTriggerNotification(message);
    }
    getState(key, defaultValue) {
        return this.#state.has(key) ? this.#state.get(key) : defaultValue;
    }
    get_state(key, defaultValue) {
        return this.getState(key, defaultValue);
    }
    setState(key, value) {
        this.#state.set(key, value);
    }
    set_state(key, value) {
        this.setState(key, value);
    }
}
//# sourceMappingURL=tool-context.js.map