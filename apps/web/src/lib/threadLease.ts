import { ThreadId } from "contracts";

const THREAD_LEASE_STORAGE_PREFIX = "shioricode:thread-lease:";
const THREAD_LEASE_CLIENT_ID_STORAGE_KEY = "shioricode:thread-lease-client-id";
const THREAD_LEASE_TTL_MS = 15_000;

interface ThreadLeaseRecord {
  ownerClientId: string;
  acquiredAt: number;
  expiresAt: number;
}

function canUseStorage(): boolean {
  return typeof window !== "undefined" && typeof window.localStorage !== "undefined";
}

function getLeaseStorageKey(threadId: ThreadId): string {
  return `${THREAD_LEASE_STORAGE_PREFIX}${threadId}`;
}

function getClientId(): string | null {
  if (typeof window === "undefined" || typeof window.sessionStorage === "undefined") {
    return null;
  }

  const existing = window.sessionStorage.getItem(THREAD_LEASE_CLIENT_ID_STORAGE_KEY);
  if (existing) {
    return existing;
  }

  const nextClientId = crypto.randomUUID();
  window.sessionStorage.setItem(THREAD_LEASE_CLIENT_ID_STORAGE_KEY, nextClientId);
  return nextClientId;
}

function readLease(threadId: ThreadId): ThreadLeaseRecord | null {
  if (!canUseStorage()) {
    return null;
  }

  const raw = window.localStorage.getItem(getLeaseStorageKey(threadId));
  if (!raw) {
    return null;
  }

  try {
    const parsed = JSON.parse(raw) as Partial<ThreadLeaseRecord>;
    if (
      typeof parsed.ownerClientId !== "string" ||
      typeof parsed.acquiredAt !== "number" ||
      typeof parsed.expiresAt !== "number"
    ) {
      return null;
    }
    return {
      ownerClientId: parsed.ownerClientId,
      acquiredAt: parsed.acquiredAt,
      expiresAt: parsed.expiresAt,
    };
  } catch {
    return null;
  }
}

function writeLease(threadId: ThreadId, lease: ThreadLeaseRecord): void {
  if (!canUseStorage()) {
    return;
  }
  window.localStorage.setItem(getLeaseStorageKey(threadId), JSON.stringify(lease));
}

export function tryAcquireThreadLease(threadId: ThreadId): boolean {
  const clientId = getClientId();
  if (!clientId || !canUseStorage()) {
    return true;
  }

  const now = Date.now();
  const current = readLease(threadId);
  if (current && current.ownerClientId !== clientId && current.expiresAt > now) {
    return false;
  }

  const nextLease: ThreadLeaseRecord = {
    ownerClientId: clientId,
    acquiredAt: current?.ownerClientId === clientId ? current.acquiredAt : now,
    expiresAt: now + THREAD_LEASE_TTL_MS,
  };
  writeLease(threadId, nextLease);

  const confirmed = readLease(threadId);
  return confirmed?.ownerClientId === clientId;
}

export function renewThreadLease(threadId: ThreadId): boolean {
  return tryAcquireThreadLease(threadId);
}

export function releaseThreadLease(threadId: ThreadId): void {
  const clientId = getClientId();
  if (!clientId || !canUseStorage()) {
    return;
  }

  const current = readLease(threadId);
  if (!current || current.ownerClientId !== clientId) {
    return;
  }

  window.localStorage.removeItem(getLeaseStorageKey(threadId));
}

export async function assertThreadLease(threadId: ThreadId): Promise<void> {
  if (tryAcquireThreadLease(threadId)) {
    return;
  }

  throw new Error(
    "This thread is currently active in another tab. Continue there or wait a few seconds before retrying.",
  );
}
