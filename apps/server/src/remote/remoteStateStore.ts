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
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { REMOTE_EXPOSURE_METHODS, type RemoteExposureMethod } from "contracts";

const REMOTE_STATE_FILE = "remote.json";

interface RemoteStateFile {
  readonly version: 2;
  readonly method: RemoteExposureMethod;
  readonly tailscaleConfirmationRequired: boolean;
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
  private cleanupRequired: boolean;
  private tailscaleConfirmationRequired: boolean;
  private mutationRevision = 0;

  constructor(input: { readonly stateDir: string }) {
    this.filePath = path.join(input.stateDir, REMOTE_STATE_FILE);
    const loaded = this.readFile();
    this.record =
      loaded.record ??
      ({
        version: 2,
        method: "off",
        tailscaleConfirmationRequired: loaded.tailscaleConfirmationRequired,
        updatedAt: new Date().toISOString(),
      } satisfies RemoteStateFile);
    this.cleanupRequired = loaded.cleanupRequired;
    this.tailscaleConfirmationRequired = loaded.tailscaleConfirmationRequired;
  }

  private readFile(): {
    readonly record: RemoteStateFile | null;
    readonly cleanupRequired: boolean;
    readonly tailscaleConfirmationRequired: boolean;
  } {
    try {
      const raw = fs.readFileSync(this.filePath, "utf8");
      const parsed = JSON.parse(raw) as {
        readonly version?: unknown;
        readonly method?: unknown;
        readonly tailscaleConfirmationRequired?: unknown;
        readonly updatedAt?: unknown;
      };
      // A method we no longer support (e.g. the retired "custom" proxy) fails
      // validation and falls back to "off" — exposure fails closed on upgrade.
      if ((parsed.version === 1 || parsed.version === 2) && isExposureMethod(parsed.method)) {
        return {
          record: {
            version: 2,
            method: parsed.method,
            tailscaleConfirmationRequired:
              parsed.version === 1 || parsed.tailscaleConfirmationRequired !== false,
            updatedAt:
              typeof parsed.updatedAt === "string" ? parsed.updatedAt : new Date().toISOString(),
          },
          cleanupRequired: false,
          // Version 1 could replace a Tailscale intent with Link/off after a
          // best-effort status read. Preserve that upgrade uncertainty until
          // tailscaled positively reports that our Serve config is gone.
          tailscaleConfirmationRequired:
            parsed.version === 1 || parsed.tailscaleConfirmationRequired !== false,
        };
      }
      return {
        record: null,
        cleanupRequired: true,
        tailscaleConfirmationRequired: true,
      };
    } catch (cause) {
      if ((cause as NodeJS.ErrnoException).code === "ENOENT") {
        return {
          record: null,
          cleanupRequired: false,
          tailscaleConfirmationRequired: false,
        };
      }
      // A torn/corrupt/unreadable record may have represented an active
      // exposure. Keep that uncertainty visible so startup tears down and
      // confirms the transport is off before lowering auth.
      return {
        record: null,
        cleanupRequired: true,
        tailscaleConfirmationRequired: true,
      };
    }
  }

  get method(): RemoteExposureMethod {
    return this.record.method;
  }

  get needsCleanup(): boolean {
    return this.cleanupRequired;
  }

  /** A legacy record may have forgotten a still-active Tailscale transport. */
  get requiresTailscaleConfirmation(): boolean {
    return this.tailscaleConfirmationRequired;
  }

  get revision(): number {
    return this.mutationRevision;
  }

  /**
   * Persist intent only after any prior Tailscale exposure has been reconciled.
   * Callers that cannot prove teardown must use transitionWithoutTailscaleTeardown.
   */
  setReconciled(method: RemoteExposureMethod): void {
    this.persist(method, false);
  }

  /**
   * Persist a CLI/offline transition without erasing existing transport
   * uncertainty. A previous Tailscale intent remains untrusted until the
   * running server positively observes Serve as off.
   */
  transitionWithoutTailscaleTeardown(method: RemoteExposureMethod): void {
    this.persist(
      method,
      this.cleanupRequired ||
        this.tailscaleConfirmationRequired ||
        this.record.method === "tailscale-serve" ||
        this.record.method === "tailscale-funnel",
    );
  }

  private persist(method: RemoteExposureMethod, tailscaleConfirmationRequired: boolean): void {
    const next = {
      version: 2,
      method,
      tailscaleConfirmationRequired,
      updatedAt: new Date().toISOString(),
    } as const;
    const temporaryPath = `${this.filePath}.${process.pid}.${randomUUID()}.tmp`;
    try {
      fs.mkdirSync(path.dirname(this.filePath), { recursive: true, mode: 0o700 });
      fs.writeFileSync(temporaryPath, `${JSON.stringify(next, null, 2)}\n`, {
        mode: 0o600,
        flag: "wx",
      });
      const descriptor = fs.openSync(temporaryPath, "r");
      try {
        fs.fsyncSync(descriptor);
      } finally {
        fs.closeSync(descriptor);
      }
      fs.renameSync(temporaryPath, this.filePath);
      this.record = next;
      this.mutationRevision += 1;
      this.cleanupRequired = false;
      this.tailscaleConfirmationRequired = tailscaleConfirmationRequired;
    } catch (cause) {
      // Never report success or change in-memory intent when the durable atomic
      // replace failed. Callers leave the network boundary untouched or retry.
      throw cause;
    } finally {
      fs.rmSync(temporaryPath, { force: true });
    }
  }
}
