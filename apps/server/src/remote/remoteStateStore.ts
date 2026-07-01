/**
 * Persisted remote-access intent for ShioriCode.
 *
 * Records which exposure the owner asked for (`{stateDir}/remote.json`, mode
 * 0600) so it survives restarts: on boot the server re-enables auth and
 * re-applies a drifted Tailscale config instead of silently coming back up
 * local-only. Follows the same plain-fs pattern as `auth/credentialStore.ts`.
 *
 * @module remote/remoteStateStore
 */
import fs from "node:fs";
import path from "node:path";

import { REMOTE_EXPOSURE_METHODS, type RemoteExposureMethod } from "contracts";

const REMOTE_STATE_FILE = "remote.json";

interface RemoteStateFile {
  readonly version: 1;
  readonly method: RemoteExposureMethod;
  readonly customUrl: string | null;
  readonly updatedAt: string;
}

function isExposureMethod(value: unknown): value is RemoteExposureMethod {
  return (
    typeof value === "string" && (REMOTE_EXPOSURE_METHODS as ReadonlyArray<string>).includes(value)
  );
}

export class RemoteStateStore {
  private readonly filePath: string;
  private record: RemoteStateFile;

  constructor(input: { readonly stateDir: string }) {
    this.filePath = path.join(input.stateDir, REMOTE_STATE_FILE);
    this.record = this.readFile() ?? {
      version: 1,
      method: "off",
      customUrl: null,
      updatedAt: new Date().toISOString(),
    };
  }

  private readFile(): RemoteStateFile | null {
    try {
      const raw = fs.readFileSync(this.filePath, "utf8");
      const parsed = JSON.parse(raw) as Partial<RemoteStateFile>;
      if (parsed.version === 1 && isExposureMethod(parsed.method)) {
        return {
          version: 1,
          method: parsed.method,
          customUrl: typeof parsed.customUrl === "string" ? parsed.customUrl : null,
          updatedAt:
            typeof parsed.updatedAt === "string" ? parsed.updatedAt : new Date().toISOString(),
        };
      }
    } catch {
      // Missing or invalid file means no remote intent was recorded yet.
    }
    return null;
  }

  get method(): RemoteExposureMethod {
    return this.record.method;
  }

  get customUrl(): string | null {
    return this.record.customUrl;
  }

  /** Persist the owner's exposure intent (0600, best-effort like credentials). */
  set(method: RemoteExposureMethod, customUrl: string | null): void {
    this.record = { version: 1, method, customUrl, updatedAt: new Date().toISOString() };
    try {
      fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
      fs.writeFileSync(this.filePath, `${JSON.stringify(this.record, null, 2)}\n`, { mode: 0o600 });
      fs.chmodSync(this.filePath, 0o600);
    } catch {
      // Best-effort persistence; the in-memory record still drives this run.
    }
  }
}
