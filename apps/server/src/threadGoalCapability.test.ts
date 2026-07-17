import { describe, expect, it } from "vitest";

import { createThreadGoalCapability } from "./threadGoalCapability.ts";

const SECRET_A = new Uint8Array(32).fill(1);
const SECRET_B = new Uint8Array(32).fill(2);

describe("thread-goal capabilities", () => {
  it("round-trips only the signed thread id", () => {
    const capability = createThreadGoalCapability(SECRET_A);
    const threadId = "thread-a" as never;
    const token = capability.issue(threadId);
    capability.commit(threadId);

    expect(capability.verify(token)).toBe("thread-a");
    expect(capability.verify(`${token.slice(0, -1)}x`)).toBeNull();
  });

  it("is process-secret scoped", () => {
    const issuer = createThreadGoalCapability(SECRET_A);
    const otherProcess = createThreadGoalCapability(SECRET_B);
    const threadId = "thread-a" as never;
    const token = issuer.issue(threadId);
    issuer.commit(threadId);

    expect(otherProcess.verify(token)).toBeNull();
  });

  it("cuts capabilities over only after provider startup succeeds", () => {
    const capability = createThreadGoalCapability(SECRET_A);
    const threadId = "thread-a" as never;
    const activeToken = capability.issue(threadId);
    capability.commit(threadId);

    capability.begin(threadId);
    const failedReplacementToken = capability.issue(threadId);
    expect(capability.verify(activeToken)).toBe("thread-a");
    expect(capability.verify(failedReplacementToken)).toBeNull();
    capability.rollback(threadId);
    expect(capability.verify(activeToken)).toBe("thread-a");
    expect(capability.verify(failedReplacementToken)).toBeNull();

    capability.begin(threadId);
    const replacementToken = capability.issue(threadId);
    capability.commit(threadId);
    expect(capability.verify(activeToken)).toBeNull();
    expect(capability.verify(replacementToken)).toBe("thread-a");

    capability.revoke(threadId);
    expect(capability.verify(replacementToken)).toBeNull();
  });

  it("reuses a committed token for resource rebuilds until a session rotation begins", () => {
    const capability = createThreadGoalCapability(SECRET_A);
    const threadId = "thread-a" as never;
    const activeToken = capability.issue(threadId);
    capability.commit(threadId);

    const rebuiltToken = capability.issue(threadId);
    expect(rebuiltToken).toBe(activeToken);
    expect(capability.verify(rebuiltToken)).toBe("thread-a");

    capability.begin(threadId);
    const pendingToken = capability.issue(threadId);
    expect(pendingToken).not.toBe(activeToken);
    expect(capability.issue(threadId)).toBe(pendingToken);
    expect(capability.verify(pendingToken)).toBeNull();
  });

  it("rejects malformed tokens and short secrets", () => {
    const capability = createThreadGoalCapability(SECRET_A);

    expect(capability.verify("not-a-token")).toBeNull();
    expect(() => createThreadGoalCapability(new Uint8Array(8))).toThrow(/at least 32 bytes/);
  });
});
