/**
 * Session and WebSocket-ticket storage for ShioriCode remote access.
 *
 * Sessions are created on credential login and persisted to
 * `{stateDir}/sessions.json` (mode 0600). Only the SHA-256 hash of each opaque
 * session token is stored; verification is an in-memory O(1) lookup, so the hot
 * path never touches disk. Sessions are revocable. WebSocket tickets are
 * short-lived, single-use, in-memory only, and bound to a session.
 *
 * @module auth/sessionStore
 */
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";

import { generateToken, hashToken } from "./tokens";

const SESSIONS_FILE = "sessions.json";
const DEFAULT_SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const LAST_SEEN_PERSIST_INTERVAL_MS = 60 * 1000;
const WS_TICKET_TTL_MS = 30 * 1000;

export interface SessionMetadata {
  readonly label?: string | undefined;
  readonly userAgent?: string | undefined;
  readonly ip?: string | undefined;
}

export interface SessionRecord {
  readonly id: string;
  readonly tokenHash: string;
  readonly username: string;
  readonly createdAt: string;
  readonly expiresAt: string;
  lastSeenAt: string;
  readonly label: string | null;
  readonly userAgent: string | null;
  readonly ip: string | null;
}

export interface SessionSummary {
  readonly id: string;
  readonly username: string;
  readonly createdAt: string;
  readonly expiresAt: string;
  readonly lastSeenAt: string;
  readonly label: string | null;
}

interface SessionsFile {
  readonly version: 1;
  readonly sessions: SessionRecord[];
}

interface WsTicketRecord {
  readonly sessionId: string;
  readonly expiresAt: number;
}

function toSummary(record: SessionRecord): SessionSummary {
  return {
    id: record.id,
    username: record.username,
    createdAt: record.createdAt,
    expiresAt: record.expiresAt,
    lastSeenAt: record.lastSeenAt,
    label: record.label,
  };
}

export class SessionStore {
  private readonly filePath: string;
  private readonly ttlMs: number;
  private readonly byId = new Map<string, SessionRecord>();
  private readonly byTokenHash = new Map<string, string>();
  private readonly tickets = new Map<string, WsTicketRecord>();

  constructor(input: { readonly stateDir: string; readonly ttlMs?: number }) {
    this.filePath = path.join(input.stateDir, SESSIONS_FILE);
    this.ttlMs = input.ttlMs ?? DEFAULT_SESSION_TTL_MS;
    this.load();
  }

  private load(): void {
    let parsed: Partial<SessionsFile> | null = null;
    try {
      parsed = JSON.parse(fs.readFileSync(this.filePath, "utf8")) as Partial<SessionsFile>;
    } catch {
      parsed = null;
    }
    const now = Date.now();
    const sessions = Array.isArray(parsed?.sessions) ? parsed.sessions : [];
    for (const session of sessions) {
      if (
        typeof session?.id !== "string" ||
        typeof session.tokenHash !== "string" ||
        typeof session.username !== "string" ||
        typeof session.expiresAt !== "string"
      ) {
        continue;
      }
      if (Date.parse(session.expiresAt) <= now) {
        continue;
      }
      const record: SessionRecord = {
        id: session.id,
        tokenHash: session.tokenHash,
        username: session.username,
        createdAt: typeof session.createdAt === "string" ? session.createdAt : session.expiresAt,
        expiresAt: session.expiresAt,
        lastSeenAt: typeof session.lastSeenAt === "string" ? session.lastSeenAt : session.createdAt,
        label: typeof session.label === "string" ? session.label : null,
        userAgent: typeof session.userAgent === "string" ? session.userAgent : null,
        ip: typeof session.ip === "string" ? session.ip : null,
      };
      this.byId.set(record.id, record);
      this.byTokenHash.set(record.tokenHash, record.id);
    }
  }

  private persist(): void {
    const file: SessionsFile = { version: 1, sessions: Array.from(this.byId.values()) };
    try {
      fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
      fs.writeFileSync(this.filePath, `${JSON.stringify(file, null, 2)}\n`, { mode: 0o600 });
      fs.chmodSync(this.filePath, 0o600);
    } catch {
      // Best-effort; in-memory sessions remain authoritative for this process.
    }
  }

  /** Create a new session and return the opaque token (shown to the client once). */
  create(input: { readonly username: string; readonly metadata?: SessionMetadata }): {
    readonly token: string;
    readonly session: SessionRecord;
  } {
    const token = generateToken(32);
    const tokenHash = hashToken(token);
    const now = new Date();
    const record: SessionRecord = {
      id: randomUUID(),
      tokenHash,
      username: input.username,
      createdAt: now.toISOString(),
      expiresAt: new Date(now.getTime() + this.ttlMs).toISOString(),
      lastSeenAt: now.toISOString(),
      label: input.metadata?.label ?? null,
      userAgent: input.metadata?.userAgent ?? null,
      ip: input.metadata?.ip ?? null,
    };
    this.byId.set(record.id, record);
    this.byTokenHash.set(tokenHash, record.id);
    this.persist();
    return { token, session: record };
  }

  /** Resolve a session from its opaque token, or null if missing/expired. */
  verifyToken(token: string): SessionRecord | null {
    const id = this.byTokenHash.get(hashToken(token));
    if (!id) {
      return null;
    }
    const record = this.byId.get(id);
    if (!record) {
      return null;
    }
    if (Date.parse(record.expiresAt) <= Date.now()) {
      this.revoke(id);
      return null;
    }
    const now = Date.now();
    if (now - Date.parse(record.lastSeenAt) > LAST_SEEN_PERSIST_INTERVAL_MS) {
      record.lastSeenAt = new Date(now).toISOString();
      this.persist();
    }
    return record;
  }

  getById(id: string): SessionRecord | null {
    return this.byId.get(id) ?? null;
  }

  revoke(id: string): void {
    const record = this.byId.get(id);
    if (!record) {
      return;
    }
    this.byId.delete(id);
    this.byTokenHash.delete(record.tokenHash);
    for (const [ticket, info] of this.tickets) {
      if (info.sessionId === id) {
        this.tickets.delete(ticket);
      }
    }
    this.persist();
  }

  revokeByToken(token: string): void {
    const id = this.byTokenHash.get(hashToken(token));
    if (id) {
      this.revoke(id);
    }
  }

  revokeOthers(currentId: string): void {
    for (const id of Array.from(this.byId.keys())) {
      if (id !== currentId) {
        this.revoke(id);
      }
    }
  }

  list(): ReadonlyArray<SessionSummary> {
    return Array.from(this.byId.values())
      .map(toSummary)
      .toSorted((left, right) => right.lastSeenAt.localeCompare(left.lastSeenAt));
  }

  /** Issue a short-lived single-use WebSocket ticket bound to a session. */
  issueTicket(sessionId: string): string {
    this.pruneTickets();
    const ticket = generateToken(24);
    this.tickets.set(ticket, { sessionId, expiresAt: Date.now() + WS_TICKET_TTL_MS });
    return ticket;
  }

  /** Consume a WebSocket ticket, returning the bound live session (single use). */
  consumeTicket(ticket: string): SessionRecord | null {
    this.pruneTickets();
    const info = this.tickets.get(ticket);
    if (!info) {
      return null;
    }
    this.tickets.delete(ticket);
    if (info.expiresAt <= Date.now()) {
      return null;
    }
    return this.getById(info.sessionId);
  }

  private pruneTickets(): void {
    const now = Date.now();
    for (const [ticket, info] of this.tickets) {
      if (info.expiresAt <= now) {
        this.tickets.delete(ticket);
      }
    }
  }
}
