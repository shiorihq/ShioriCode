import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

import type { ThreadId } from "contracts";

const TOKEN_VERSION = "v1";
const TOKEN_SCOPE = "shioricode-thread-goal";
const DEFAULT_SECRET = randomBytes(32);

interface CapabilityPayload {
  readonly version: 1;
  readonly scope: typeof TOKEN_SCOPE;
  readonly threadId: string;
  readonly nonce: string;
}

export interface ThreadGoalCapability {
  readonly begin: (threadId: ThreadId) => void;
  readonly issue: (threadId: ThreadId) => string;
  readonly verify: (token: string) => ThreadId | null;
  readonly commit: (threadId: ThreadId) => void;
  readonly rollback: (threadId: ThreadId) => void;
  readonly revoke: (threadId: ThreadId) => void;
}

function signatureFor(payload: string, secret: Uint8Array): Buffer {
  return createHmac("sha256", secret).update(`${TOKEN_VERSION}.${payload}`).digest();
}

/**
 * Creates a thread-goal capability issuer/verifier.
 *
 * The production singleton uses an in-memory random secret, so capabilities
 * expire automatically when the ShioriCode server process exits. The thread id
 * is signed into the token and is never accepted from an HTTP request body.
 */
export function createThreadGoalCapability(
  secret: Uint8Array = DEFAULT_SECRET,
): ThreadGoalCapability {
  const key = Buffer.from(secret);
  const activeNonces = new Map<string, string>();
  const pendingNonces = new Map<string, string>();
  if (key.byteLength < 32) {
    throw new Error("Thread-goal capability secrets must contain at least 32 bytes.");
  }

  const makeToken = (threadId: string, nonce: string): string => {
    const payload: CapabilityPayload = {
      version: 1,
      scope: TOKEN_SCOPE,
      threadId,
      nonce,
    };
    const encodedPayload = Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
    const signature = signatureFor(encodedPayload, key).toString("base64url");
    return `${TOKEN_VERSION}.${encodedPayload}.${signature}`;
  };

  const begin = (threadId: ThreadId): void => {
    const threadKey = String(threadId);
    if (!pendingNonces.has(threadKey)) {
      pendingNonces.set(threadKey, randomBytes(24).toString("base64url"));
    }
  };

  return {
    begin,
    issue: (threadId) => {
      const threadKey = String(threadId);
      let nonce = pendingNonces.get(threadKey) ?? activeNonces.get(threadKey);
      if (nonce === undefined) {
        begin(threadId);
        nonce = pendingNonces.get(threadKey);
      }
      if (nonce === undefined) {
        throw new Error("Failed to issue a thread-goal capability nonce.");
      }
      // Provider adapters may rebuild their MCP resources inside an existing
      // session (for example after a model/config change). Outside an explicit
      // ProviderService rotation, reuse the committed token so the rebuilt
      // resource remains authorized. A session start calls begin() first and
      // receives the stable pending token until commit().
      return makeToken(threadKey, nonce);
    },
    verify: (token) => {
      const parts = token.split(".");
      if (parts.length !== 3 || parts[0] !== TOKEN_VERSION) {
        return null;
      }
      const encodedPayload = parts[1];
      const encodedSignature = parts[2];
      if (!encodedPayload || !encodedSignature) {
        return null;
      }

      let signature: Buffer;
      try {
        signature = Buffer.from(encodedSignature, "base64url");
      } catch {
        return null;
      }
      if (signature.toString("base64url") !== encodedSignature) {
        return null;
      }
      const expected = signatureFor(encodedPayload, key);
      if (signature.byteLength !== expected.byteLength || !timingSafeEqual(signature, expected)) {
        return null;
      }

      try {
        const payload = JSON.parse(
          Buffer.from(encodedPayload, "base64url").toString("utf8"),
        ) as Partial<CapabilityPayload>;
        if (
          payload.version !== 1 ||
          payload.scope !== TOKEN_SCOPE ||
          typeof payload.threadId !== "string" ||
          payload.threadId.trim().length === 0 ||
          payload.threadId.length > 4_096 ||
          typeof payload.nonce !== "string" ||
          payload.nonce.length < 16 ||
          activeNonces.get(payload.threadId) !== payload.nonce
        ) {
          return null;
        }
        return payload.threadId as ThreadId;
      } catch {
        return null;
      }
    },
    commit: (threadId) => {
      const key = String(threadId);
      const pendingNonce = pendingNonces.get(key);
      if (pendingNonce === undefined) return;
      activeNonces.set(key, pendingNonce);
      pendingNonces.delete(key);
    },
    rollback: (threadId) => {
      pendingNonces.delete(String(threadId));
    },
    revoke: (threadId) => {
      const key = String(threadId);
      activeNonces.delete(key);
      pendingNonces.delete(key);
    },
  };
}

const processThreadGoalCapability = createThreadGoalCapability();

export function beginThreadGoalCapabilityRotation(threadId: ThreadId): void {
  processThreadGoalCapability.begin(threadId);
}

export function issueThreadGoalCapability(threadId: ThreadId): string {
  return processThreadGoalCapability.issue(threadId);
}

export function verifyThreadGoalCapability(token: string): ThreadId | null {
  return processThreadGoalCapability.verify(token);
}

export function commitThreadGoalCapability(threadId: ThreadId): void {
  processThreadGoalCapability.commit(threadId);
}

export function rollbackThreadGoalCapability(threadId: ThreadId): void {
  processThreadGoalCapability.rollback(threadId);
}

export function revokeThreadGoalCapability(threadId: ThreadId): void {
  processThreadGoalCapability.revoke(threadId);
}
