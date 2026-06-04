import { EventEmitter } from "node:events";
import { Readable } from "node:stream";
import { LocalConnection } from "./local-connection.js";
class AsyncQueue {
    #items = [];
    #waiters = [];
    push(item) {
        const waiter = this.#waiters.shift();
        if (waiter) {
            waiter(item);
            return;
        }
        this.#items.push(item);
    }
    async shift(timeoutMs) {
        if (this.#items.length) {
            return this.#items.shift();
        }
        return await new Promise((resolve, reject) => {
            let timeout;
            if (timeoutMs !== undefined) {
                timeout = setTimeout(() => reject(new Error(`Timed out after ${timeoutMs}ms`)), timeoutMs);
            }
            this.#waiters.push((value) => {
                if (timeout) {
                    clearTimeout(timeout);
                }
                resolve(value);
            });
        });
    }
}
export class TestWebSocket extends EventTarget {
    #incomingQueue = new AsyncQueue();
    sentMessages = [];
    sentQueue = new AsyncQueue();
    readyState = WebSocket.OPEN;
    send(message) {
        this.sentMessages.push(message);
        this.sentQueue.push(message);
    }
    putEvent(event) {
        const data = JSON.stringify(event);
        this.#incomingQueue.push(data);
        this.dispatchEvent(new MessageEvent("message", {
            data,
        }));
    }
    close() {
        this.readyState = WebSocket.CLOSED;
        this.#incomingQueue.push(undefined);
        this.dispatchEvent(new CloseEvent("close"));
    }
    async nextSent(timeoutMs) {
        return await this.sentQueue.shift(timeoutMs);
    }
    async *[Symbol.asyncIterator]() {
        while (true) {
            const next = await this.#incomingQueue.shift();
            if (next === undefined) {
                return;
            }
            yield next;
        }
    }
}
class FakeProcess extends EventEmitter {
    stdin = {
        end: () => {
            this.exitCode = 0;
            this.emit("exit", 0, null);
        },
    };
    stderr = new Readable({
        read() { },
    });
    killed = false;
    exitCode = null;
    kill() {
        this.killed = true;
        this.exitCode = 0;
        this.emit("exit", 0, null);
        return true;
    }
    once(eventName, listener) {
        if (eventName === "exit" && this.exitCode !== null) {
            queueMicrotask(() => listener(this.exitCode, null));
            return this;
        }
        return super.once(eventName, listener);
    }
}
export class TestLocalHarness {
    ws;
    conn;
    constructor(init = {}) {
        this.ws = init.ws ?? new TestWebSocket();
        this.conn = new LocalConnection({
            process: (init.process ?? new FakeProcess()),
            ws: this.ws,
            toolRunner: init.toolRunner ?? init.tool_runner,
            hookRunner: init.hookRunner ?? init.hook_runner,
            conversationId: init.conversationId ?? init.conversation_id,
        });
    }
    async disconnectSdk() {
        await this.conn.disconnect();
    }
    disconnect_sdk() {
        return this.disconnectSdk();
    }
    async closeFromHarnessSide() {
        this.ws.close();
    }
    close_from_harness_side() {
        return this.closeFromHarnessSide();
    }
    async waitForResponse(timeout = 10_000) {
        return JSON.parse(await this.ws.nextSent(timeout));
    }
    wait_for_response(timeout = 10_000) {
        return this.waitForResponse(timeout);
    }
    async waitForEvent(event, timeout = 10_000) {
        await Promise.race([
            event,
            new Promise((_resolve, reject) => setTimeout(() => reject(new Error(`Timed out after ${timeout}ms`)), timeout)),
        ]);
    }
    wait_for_event(event, timeout = 10_000) {
        return this.waitForEvent(event, timeout);
    }
    async sendEvent(event) {
        this.ws.putEvent(event);
    }
    send_event(event) {
        return this.sendEvent(event);
    }
    async sendToolCall(id, name, argumentsJson) {
        await this.sendEvent({
            toolCall: {
                id,
                name,
                argumentsJson,
            },
        });
    }
    send_tool_call(id, name, arguments_json) {
        return this.sendToolCall(id, name, arguments_json);
    }
    async sendToolConfirmationRequest(trajectoryId, stepIndex, fields = {}) {
        await this.sendEvent({
            stepUpdate: {
                trajectoryId,
                stepIndex,
                state: "STATE_WAITING_FOR_USER",
                toolConfirmationRequest: {},
                ...fields,
            },
        });
    }
    send_tool_confirmation_request(trajectory_id, step_index, fields = {}) {
        return this.sendToolConfirmationRequest(trajectory_id, step_index, fields);
    }
}
//# sourceMappingURL=test-utils.js.map