import { randomBytes } from "node:crypto";
import os from "node:os";

import type {
  RemoteBeginLinkSignInInput,
  RemoteBeginLinkSignInResult,
  RemoteLinkStatus,
} from "contracts";

import { FrpcConnector } from "./frpcConnector";
import { LinkControlPlaneClient } from "./linkClient";
import { LinkRemoteStore, type LinkConnectorCredential } from "./linkStore";

const DEFAULT_SHIORI_ORIGIN = "https://shiori.codes";
const DEFAULT_CALLBACK_SCHEME = "shioricode";
const AUTH_WINDOW_MS = 10 * 60 * 1000;

function resolveCallbackScheme(value: string | undefined): string {
  return value?.trim() === "shioricode-dev" ? "shioricode-dev" : DEFAULT_CALLBACK_SCHEME;
}

export interface LinkAuthCallbackInput {
  readonly state: string;
  readonly token?: string;
  readonly refreshToken?: string;
  readonly error?: string;
}

export interface LinkHostedAccessPrincipal {
  readonly username: string;
}

export interface LinkRemoteConnector {
  readonly installed: boolean;
  readonly running: boolean;
  readonly lastError: string | null;
  readonly cleanupRequired?: boolean;
  start(credential: LinkConnectorCredential): Promise<void>;
  stop(): Promise<void>;
}

export interface LinkRemoteClient {
  provision(input: {
    readonly instanceId: string;
    readonly displayName: string;
  }): Promise<LinkConnectorCredential>;
  revoke(environmentRecordId: string): Promise<void>;
}

export class LinkRemote {
  readonly #store: LinkRemoteStore;
  readonly #client: LinkRemoteClient;
  readonly #connector: LinkRemoteConnector;
  readonly #origin: string;
  readonly #callbackScheme: string;
  #lastError: string | null = null;

  constructor(input: {
    readonly stateDir: string;
    readonly localPort: number;
    readonly origin?: string;
    readonly callbackScheme?: string;
    /** @internal Test seams for the process and control-plane boundaries. */
    readonly store?: LinkRemoteStore;
    readonly client?: LinkRemoteClient;
    readonly connector?: LinkRemoteConnector;
  }) {
    this.#store = input.store ?? new LinkRemoteStore({ stateDir: input.stateDir });
    this.#origin = (input.origin ?? process.env.SHIORICODE_LINK_API_URL ?? DEFAULT_SHIORI_ORIGIN)
      .trim()
      .replace(/\/$/, "");
    this.#callbackScheme = resolveCallbackScheme(
      input.callbackScheme ?? process.env.SHIORICODE_DESKTOP_SCHEME,
    );
    this.#client =
      input.client ?? new LinkControlPlaneClient({ store: this.#store, origin: this.#origin });
    this.#connector =
      input.connector ??
      new FrpcConnector({
        stateDir: input.stateDir,
        localPort: input.localPort,
      });
  }

  get endpoint(): string | null {
    return this.#store.connector?.endpoint ?? null;
  }

  get running(): boolean {
    return this.#connector.running;
  }

  status(): RemoteLinkStatus {
    return {
      accountLinked: this.#store.account !== null,
      connectorInstalled: this.#connector.installed,
      connectorRunning: this.#connector.running,
      endpoint: this.endpoint,
      lastError: this.#connector.lastError ?? this.#lastError,
    };
  }

  get hostedAccessAvailable(): boolean {
    return this.running && this.hostedAccessConfigured;
  }

  get hostedAccessConfigured(): boolean {
    return this.#store.account !== null && this.#store.connector !== null;
  }

  get managedProcessCleanupRequired(): boolean {
    return this.#connector.cleanupRequired === true;
  }

  beginHostedAccess(state: string): string {
    const connector = this.#store.connector;
    if (!this.hostedAccessAvailable || !connector) {
      throw new Error("ShioriCode Link is not connected");
    }
    const authUrl = new URL("/api/shiori-code/link/access/start", this.#origin);
    authUrl.searchParams.set("environment", connector.environmentRecordId);
    authUrl.searchParams.set("state", state);
    return authUrl.toString();
  }

  async exchangeHostedAccess(code: string): Promise<LinkHostedAccessPrincipal> {
    const connector = this.#store.connector;
    if (!this.hostedAccessAvailable || !connector) {
      throw new Error("ShioriCode Link is not connected");
    }
    const response = await fetch(`${this.#origin}/api/shiori-code/link/access/exchange`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Shiori-Client": "server" },
      body: JSON.stringify({ environmentId: connector.environmentRecordId, code }),
      signal: AbortSignal.timeout(15_000),
    });
    const body = (await response.json().catch(() => null)) as {
      principal?: { username?: unknown };
    } | null;
    if (!response.ok || typeof body?.principal?.username !== "string") {
      throw new Error("The hosted sign-in code is invalid or expired");
    }
    return { username: body.principal.username };
  }

  beginSignIn(input: RemoteBeginLinkSignInInput): RemoteBeginLinkSignInResult {
    const state = randomBytes(32).toString("base64url");
    const expiresAt = new Date(Date.now() + AUTH_WINDOW_MS).toISOString();
    this.#store.setPendingAuth({ state, expiresAt });

    const callback = new URL(`${this.#callbackScheme}://app/index.html`);
    callback.searchParams.set("link-auth", "callback");
    const authUrl = new URL("/api/shiori-code/link/auth/start", this.#origin);
    authUrl.searchParams.set("provider", input.provider);
    authUrl.searchParams.set("redirect", callback.toString());
    authUrl.searchParams.set("state", state);
    return { authUrl: authUrl.toString(), expiresAt };
  }

  completeSignIn(input: LinkAuthCallbackInput): void {
    this.#store.assertPendingAuth(input.state);
    if (input.error) {
      this.#store.clearPendingAuth();
      throw new Error(`Shiori sign-in failed: ${input.error}`);
    }
    if (!input.token || !input.refreshToken) {
      this.#store.clearPendingAuth();
      throw new Error("Shiori sign-in did not return a session");
    }
    this.#store.completeAuth({
      state: input.state,
      accessToken: input.token,
      refreshToken: input.refreshToken,
    });
    this.#lastError = null;
  }

  async enable(): Promise<void> {
    if (!this.#store.account) {
      throw new Error("Sign in to Shiori before enabling Link access");
    }
    try {
      const credential = await this.#client.provision({
        instanceId: this.#store.instanceId,
        displayName: os.hostname() || "ShioriCode",
      });
      await this.#connector.stop();
      this.#store.setConnector(credential);
      await this.#connector.start(credential);
      this.#lastError = null;
    } catch (error) {
      this.#lastError = error instanceof Error ? error.message : "Could not enable ShioriCode Link";
      throw error;
    }
  }

  async restore(): Promise<boolean> {
    const credential = this.#store.connector;
    if (!credential || !this.#store.account) return false;
    try {
      await this.#connector.start(credential);
      this.#lastError = null;
      return true;
    } catch (error) {
      this.#lastError =
        error instanceof Error ? error.message : "Could not restore ShioriCode Link";
      return false;
    }
  }

  async disable(): Promise<void> {
    await this.#connector.stop();
    const credential = this.#store.connector;
    if (credential && this.#store.account) {
      try {
        await this.#client.revoke(credential.environmentRecordId);
        this.#store.clearConnector();
        this.#lastError = null;
      } catch (error) {
        this.#lastError =
          error instanceof Error ? error.message : "Could not revoke the link environment";
      }
    } else if (credential) {
      this.#store.clearConnector();
    }
  }

  async disconnectAccount(): Promise<void> {
    await this.disable();
    this.#store.clearAccount();
  }

  async dispose(): Promise<void> {
    await this.#connector.stop();
  }
}
