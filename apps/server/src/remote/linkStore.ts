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

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function parseState(value: unknown): LinkStateFile | null {
  if (!value || typeof value !== "object") return null;
  const record = value as Partial<LinkStateFile>;
  if (record.version !== 1 || !isNonEmptyString(record.instanceId)) return null;

  const account = record.account;
  if (
    account !== null &&
    (!account || !isNonEmptyString(account.accessToken) || !isNonEmptyString(account.refreshToken))
  ) {
    return null;
  }
  const pendingAuth = record.pendingAuth;
  if (
    pendingAuth !== null &&
    (!pendingAuth ||
      !isNonEmptyString(pendingAuth.state) ||
      !isNonEmptyString(pendingAuth.expiresAt))
  ) {
    return null;
  }
  const connector = record.connector;
  if (
    connector !== null &&
    (!connector ||
      !isNonEmptyString(connector.environmentRecordId) ||
      !isNonEmptyString(connector.environmentId) ||
      !isNonEmptyString(connector.endpoint) ||
      !isNonEmptyString(connector.serverAddr) ||
      !Number.isInteger(connector.serverPort) ||
      connector.serverPort < 1 ||
      connector.serverPort > 65_535 ||
      connector.serverTls !== true ||
      !isNonEmptyString(connector.token) ||
      !isNonEmptyString(connector.updatedAt))
  ) {
    return null;
  }
  return {
    version: 1,
    instanceId: record.instanceId,
    account: account ?? null,
    pendingAuth: pendingAuth ?? null,
    connector: connector ?? null,
  };
}

export class LinkRemoteStore {
  readonly #filePath: string;
  #record: LinkStateFile;

  constructor(input: { readonly stateDir: string }) {
    this.#filePath = path.join(input.stateDir, LINK_STATE_FILE);
    const existing = this.#read();
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
    this.#persist();
  }

  #read(): LinkStateFile | null {
    try {
      const stat = fs.statSync(this.#filePath);
      if (stat.size > MAX_STATE_BYTES) return null;
      return parseState(JSON.parse(fs.readFileSync(this.#filePath, "utf8")));
    } catch {
      return null;
    }
  }

  #persist(): void {
    fs.mkdirSync(path.dirname(this.#filePath), { recursive: true });
    const temporaryPath = `${this.#filePath}.${process.pid}.${randomUUID()}.tmp`;
    try {
      fs.writeFileSync(temporaryPath, `${JSON.stringify(this.#record, null, 2)}\n`, {
        mode: 0o600,
        flag: "wx",
      });
      fs.chmodSync(temporaryPath, 0o600);
      fs.renameSync(temporaryPath, this.#filePath);
      fs.chmodSync(this.#filePath, 0o600);
    } finally {
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
    const pending = this.#record.pendingAuth;
    const now = input.now ?? Date.now();
    if (
      !pending ||
      pending.state !== input.state ||
      Date.parse(pending.expiresAt) <= now ||
      !input.accessToken ||
      !input.refreshToken
    ) {
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
