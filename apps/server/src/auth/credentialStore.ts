/**
 * Owner credential storage for ShioriCode remote access.
 *
 * A single owner account (username + password) gates remote access. The
 * password is stored only as a scrypt hash in `{stateDir}/credentials.json`
 * (mode 0600). If the file is missing, credentials can be seeded once from the
 * SHIORICODE_USERNAME / SHIORICODE_PASSWORD environment variables.
 *
 * @module auth/credentialStore
 */
import fs from "node:fs";
import path from "node:path";

import { hashPassword, verifyPassword } from "./passwords";
import { safeEqualUtf8 } from "./tokens";

const CREDENTIALS_FILE = "credentials.json";

interface CredentialsFile {
  readonly version: 1;
  readonly username: string;
  readonly passwordHash: string;
  readonly updatedAt: string;
}

export interface CredentialStoreInput {
  readonly stateDir: string;
  readonly envUsername?: string | undefined;
  readonly envPassword?: string | undefined;
}

export class CredentialStore {
  private readonly filePath: string;
  private record: CredentialsFile | null = null;

  constructor(input: CredentialStoreInput) {
    this.filePath = path.join(input.stateDir, CREDENTIALS_FILE);
    const existing = this.readFile();
    if (existing) {
      this.record = existing;
    } else if (input.envUsername && input.envPassword) {
      this.setCredentials(input.envUsername, input.envPassword);
    }
  }

  private readFile(): CredentialsFile | null {
    try {
      const raw = fs.readFileSync(this.filePath, "utf8");
      const parsed = JSON.parse(raw) as Partial<CredentialsFile>;
      if (
        parsed.version === 1 &&
        typeof parsed.username === "string" &&
        typeof parsed.passwordHash === "string"
      ) {
        return {
          version: 1,
          username: parsed.username,
          passwordHash: parsed.passwordHash,
          updatedAt:
            typeof parsed.updatedAt === "string" ? parsed.updatedAt : new Date().toISOString(),
        };
      }
    } catch {
      // Missing or invalid file means credentials are not configured yet.
    }
    return null;
  }

  get isConfigured(): boolean {
    return this.record !== null;
  }

  get username(): string | null {
    return this.record?.username ?? null;
  }

  /** Set (or rotate) the owner credentials and persist them 0600. */
  setCredentials(username: string, password: string): void {
    const record: CredentialsFile = {
      version: 1,
      username: username.trim(),
      passwordHash: hashPassword(password),
      updatedAt: new Date().toISOString(),
    };
    this.record = record;
    try {
      fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
      fs.writeFileSync(this.filePath, `${JSON.stringify(record, null, 2)}\n`, { mode: 0o600 });
      fs.chmodSync(this.filePath, 0o600);
    } catch {
      // Best-effort persistence; the in-memory record is still usable this run.
    }
  }

  /**
   * Verify a username/password pair. The password hash is always computed even
   * when the username does not match, so this does not leak which half failed.
   */
  verify(username: string, password: string): boolean {
    const record = this.record;
    if (!record) {
      return false;
    }
    const usernameMatches = safeEqualUtf8(username.trim(), record.username);
    const passwordMatches = verifyPassword(password, record.passwordHash);
    return usernameMatches && passwordMatches;
  }
}
