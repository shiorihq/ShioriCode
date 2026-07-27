import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const LINK_STATE_FILE = "link-remote.json";
const MAX_STATE_BYTES = 128 * 1024;

export interface LinkAccountTokens {
  readonly accessToken: string;
  readonly refreshToken: string;
}

export interface LinkConnectorCredential {
  readonly environmentRecordId: string;
  readonly environmentId: string;
  readonly endpoint: string;
  readonly serverAddr: string;
  readonly serverPort: number;
  readonly serverTls: true;
  readonly token: string;
  readonly updatedAt: string;
}

interface PendingLinkAuth {
  readonly state: string;
  readonly expiresAt: string;
}

interface LinkStateFile {
  readonly version: 1;
  readonly instanceId: string;
  readonly account: LinkAccountTokens | null;
  readonly pendingAuth: PendingLinkAuth | null;
  readonly connector: LinkConnectorCredential | null;
}

export function isNonEmptyLinkString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

export function isValidLinkServerPort(value: unknown): value is number {
  return Number.isInteger(value) && (value as number) >= 1 && (value as number) <= 65_535;
}

function parseAccount(value: unknown): LinkAccountTokens | null {
  if (!value || typeof value !== "object") return null;
  const account = value as Partial<LinkAccountTokens>;
  if (!isNonEmptyLinkString(account.accessToken) || !isNonEmptyLinkString(account.refreshToken)) {
    return null;
  }
  return { accessToken: account.accessToken, refreshToken: account.refreshToken };
}

function parsePendingAuth(value: unknown): PendingLinkAuth | null {
  if (!value || typeof value !== "object") return null;
  const pendingAuth = value as Partial<PendingLinkAuth>;
  if (
    !isNonEmptyLinkString(pendingAuth.state) ||
    !isNonEmptyLinkString(pendingAuth.expiresAt) ||
    !Number.isFinite(Date.parse(pendingAuth.expiresAt))
  ) {
    return null;
  }
  return { state: pendingAuth.state, expiresAt: pendingAuth.expiresAt };
}

function parseConnector(value: unknown): LinkConnectorCredential | null {
  if (!value || typeof value !== "object") return null;
  const connector = value as Partial<LinkConnectorCredential>;
  if (
    !isNonEmptyLinkString(connector.environmentRecordId) ||
    !isNonEmptyLinkString(connector.environmentId) ||
    !isNonEmptyLinkString(connector.endpoint) ||
    !isNonEmptyLinkString(connector.serverAddr) ||
    !isValidLinkServerPort(connector.serverPort) ||
    connector.serverTls !== true ||
    !isNonEmptyLinkString(connector.token) ||
    !isNonEmptyLinkString(connector.updatedAt)
  ) {
    return null;
  }
  return {
    environmentRecordId: connector.environmentRecordId,
    environmentId: connector.environmentId,
    endpoint: connector.endpoint,
    serverAddr: connector.serverAddr,
    serverPort: connector.serverPort,
    serverTls: true,
    token: connector.token,
    updatedAt: connector.updatedAt,
  };
}

function parseState(value: unknown): LinkStateFile {
  if (!value || typeof value !== "object") {
    throw new Error("The persisted ShioriCode Link state is invalid");
  }
  const record = value as Partial<LinkStateFile>;
  if (record.version !== 1 || !isNonEmptyLinkString(record.instanceId)) {
    throw new Error("The persisted ShioriCode Link state has an invalid version or instance id");
  }
  return {
    version: 1,
    instanceId: record.instanceId,
    account: parseAccount(record.account),
    pendingAuth: parsePendingAuth(record.pendingAuth),
    connector: parseConnector(record.connector),
  };
}

function linkStatePath(stateDir: string): string {
  return path.join(stateDir, LINK_STATE_FILE);
}

function isMissingFileError(error: unknown): boolean {
  return (error as NodeJS.ErrnoException | null)?.code === "ENOENT";
}

function readStateFile(filePath: string): LinkStateFile | null {
  let descriptor: number;
  try {
    descriptor = fs.openSync(filePath, "r");
  } catch (error) {
    if (isMissingFileError(error)) return null;
    throw error;
  }
  try {
    const stat = fs.fstatSync(descriptor);
    if (stat.size > MAX_STATE_BYTES) {
      throw new Error("The persisted ShioriCode Link state is unexpectedly large");
    }
    const contents = fs.readFileSync(descriptor);
    if (contents.byteLength > MAX_STATE_BYTES) {
      throw new Error("The persisted ShioriCode Link state is unexpectedly large");
    }
    return parseState(JSON.parse(contents.toString("utf8")));
  } finally {
    fs.closeSync(descriptor);
  }
}

/** Read persisted hosted-access readiness without creating or modifying service state. */
export function hasPersistedLinkHostedAccess(stateDir: string): boolean {
  const record = readStateFile(linkStatePath(stateDir));
  return Boolean(record?.account && record.connector);
}

export class LinkRemoteStore {
  readonly #filePath: string;
  #record: LinkStateFile;

  constructor(input: { readonly stateDir: string; readonly createIfMissing?: boolean }) {
    this.#filePath = linkStatePath(input.stateDir);
    const existing = readStateFile(this.#filePath);
    if (existing) {
      this.#record = existing;
      return;
    }
    this.#record = {
      version: 1,
      instanceId: randomUUID(),
      account: null,
      pendingAuth: null,
      connector: null,
    };
    if (input.createIfMissing !== false) this.#persist();
  }

  #persist(): void {
    fs.mkdirSync(path.dirname(this.#filePath), { recursive: true });
    const temporaryPath = `${this.#filePath}.${process.pid}.${randomUUID()}.tmp`;
    let descriptor: number | null = null;
    try {
      descriptor = fs.openSync(temporaryPath, "wx", 0o600);
      fs.writeFileSync(descriptor, `${JSON.stringify(this.#record, null, 2)}\n`);
      fs.fsyncSync(descriptor);
      fs.closeSync(descriptor);
      descriptor = null;
      fs.chmodSync(temporaryPath, 0o600);
      fs.renameSync(temporaryPath, this.#filePath);
      fs.chmodSync(this.#filePath, 0o600);
    } finally {
      if (descriptor !== null) fs.closeSync(descriptor);
      fs.rmSync(temporaryPath, { force: true });
    }
  }

  get instanceId(): string {
    return this.#record.instanceId;
  }

  get account(): LinkAccountTokens | null {
    return this.#record.account;
  }

  get connector(): LinkConnectorCredential | null {
    return this.#record.connector;
  }

  assertPendingAuth(state: string, now = Date.now()): void {
    const pending = this.#record.pendingAuth;
    const expiresAt = pending ? Date.parse(pending.expiresAt) : Number.NaN;
    if (!pending || pending.state !== state || !Number.isFinite(expiresAt) || expiresAt <= now) {
      throw new Error("Link sign-in callback is invalid or expired");
    }
  }

  setPendingAuth(input: PendingLinkAuth): void {
    this.#record = { ...this.#record, pendingAuth: input };
    this.#persist();
  }

  completeAuth(input: {
    readonly state: string;
    readonly accessToken: string;
    readonly refreshToken: string;
    readonly now?: number;
  }): void {
    const now = input.now ?? Date.now();
    this.assertPendingAuth(input.state, now);
    if (!input.accessToken || !input.refreshToken) {
      throw new Error("Link sign-in callback is invalid or expired");
    }
    this.#record = {
      ...this.#record,
      account: {
        accessToken: input.accessToken,
        refreshToken: input.refreshToken,
      },
      pendingAuth: null,
    };
    this.#persist();
  }

  clearPendingAuth(): void {
    this.#record = { ...this.#record, pendingAuth: null };
    this.#persist();
  }

  setAccount(tokens: LinkAccountTokens): void {
    this.#record = { ...this.#record, account: tokens };
    this.#persist();
  }

  setConnector(connector: LinkConnectorCredential): void {
    this.#record = { ...this.#record, connector };
    this.#persist();
  }

  clearConnector(): void {
    this.#record = { ...this.#record, connector: null };
    this.#persist();
  }

  clearAccount(): void {
    this.#record = {
      ...this.#record,
      account: null,
      pendingAuth: null,
      connector: null,
    };
    this.#persist();
  }
}
