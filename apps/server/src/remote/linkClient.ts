import {
  isNonEmptyLinkString,
  isValidLinkServerPort,
  type LinkConnectorCredential,
  type LinkRemoteStore,
} from "./linkStore";

const DEFAULT_SHIORI_ORIGIN = "https://shiori.codes";
const REQUEST_TIMEOUT_MS = 15_000;

interface ProvisionResponse {
  environment: {
    id: string;
    endpoint: string;
  };
  connector: {
    serverAddr: string;
    serverPort: number;
    serverTls: true;
    environmentId: string;
    token: string;
  };
}

export interface LinkEnvironmentSummary {
  readonly id: string;
  readonly instanceId: string;
  readonly displayName: string;
  readonly endpoint: string;
  readonly status: "pending" | "active" | "revoked";
  readonly relay: {
    readonly reachable: boolean;
    readonly online: boolean;
  };
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseProvisionResponse(value: unknown): ProvisionResponse {
  if (!isObject(value) || !isObject(value.environment) || !isObject(value.connector)) {
    throw new Error("Shiori returned an invalid link environment response");
  }
  const environment = value.environment;
  const connector = value.connector;
  if (
    !isNonEmptyLinkString(environment.id) ||
    !isNonEmptyLinkString(environment.endpoint) ||
    !isNonEmptyLinkString(connector.serverAddr) ||
    !isValidLinkServerPort(connector.serverPort) ||
    connector.serverTls !== true ||
    !isNonEmptyLinkString(connector.environmentId) ||
    !isNonEmptyLinkString(connector.token)
  ) {
    throw new Error("Shiori returned an invalid link connector credential");
  }
  return {
    environment: { id: environment.id, endpoint: environment.endpoint },
    connector: {
      serverAddr: connector.serverAddr,
      serverPort: connector.serverPort,
      serverTls: true,
      environmentId: connector.environmentId,
      token: connector.token,
    },
  };
}

export class LinkControlPlaneClient {
  readonly #origin: string;
  readonly #store: LinkRemoteStore;

  constructor(input: { readonly store: LinkRemoteStore; readonly origin?: string }) {
    this.#store = input.store;
    this.#origin = (input.origin ?? process.env.SHIORICODE_LINK_API_URL ?? DEFAULT_SHIORI_ORIGIN)
      .trim()
      .replace(/\/$/, "");
  }

  async #refreshAccount(): Promise<void> {
    const account = this.#store.account;
    if (!account) throw new Error("Sign in to Shiori before enabling Link access");
    const response = await fetch(`${this.#origin}/api/shiori-code/link/auth/refresh`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "User-Agent": "ShioriCode/0.5",
        "X-Shiori-Client": "electron",
      },
      body: JSON.stringify({ refreshToken: account.refreshToken }),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (!response.ok) {
      if (response.status === 401) this.#store.clearAccount();
      throw new Error(
        response.status === 401
          ? "Your Shiori session expired; sign in again"
          : `Could not refresh your Shiori session (${response.status})`,
      );
    }
    const body = (await response.json()) as { token?: unknown; refreshToken?: unknown };
    if (typeof body.token !== "string" || typeof body.refreshToken !== "string") {
      throw new Error("Shiori returned an invalid refreshed session");
    }
    this.#store.setAccount({ accessToken: body.token, refreshToken: body.refreshToken });
  }

  async #request(pathname: string, init: RequestInit, retry = true): Promise<Response> {
    const account = this.#store.account;
    if (!account) throw new Error("Sign in to Shiori before enabling Link access");
    const response = await fetch(`${this.#origin}${pathname}`, {
      ...init,
      cache: "no-store",
      headers: {
        Authorization: `Bearer ${account.accessToken}`,
        "Content-Type": "application/json",
        "User-Agent": "ShioriCode/0.5",
        "X-Shiori-Client": "electron",
        ...init.headers,
      },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (response.status === 401 && retry) {
      await this.#refreshAccount();
      return await this.#request(pathname, init, false);
    }
    return response;
  }

  async provision(input: {
    readonly instanceId: string;
    readonly displayName: string;
  }): Promise<LinkConnectorCredential> {
    const response = await this.#request("/api/shiori-code/link/environments", {
      method: "POST",
      body: JSON.stringify(input),
    });
    if (!response.ok) {
      throw new Error(`Could not provision ShioriCode Link (${response.status})`);
    }
    const result = parseProvisionResponse(await response.json());
    return {
      environmentRecordId: result.environment.id,
      environmentId: result.connector.environmentId,
      endpoint: result.environment.endpoint,
      serverAddr: result.connector.serverAddr,
      serverPort: result.connector.serverPort,
      serverTls: true,
      token: result.connector.token,
      updatedAt: new Date().toISOString(),
    };
  }

  async list(): Promise<readonly LinkEnvironmentSummary[]> {
    // CLI list/status operations must never rotate the service's credentials behind
    // its back. A 401 is reported to the operator without refreshing or persisting.
    const response = await this.#request(
      "/api/shiori-code/link/environments",
      { method: "GET" },
      false,
    );
    if (!response.ok) {
      throw new Error(`Could not list ShioriCode Link environments (${response.status})`);
    }
    const body = (await response.json()) as { environments?: unknown };
    if (!Array.isArray(body.environments)) {
      throw new Error("Shiori returned an invalid link environment list");
    }
    return body.environments.flatMap((value): LinkEnvironmentSummary[] => {
      if (!isObject(value) || !isObject(value.relay)) return [];
      if (
        typeof value.id !== "string" ||
        typeof value.instanceId !== "string" ||
        typeof value.displayName !== "string" ||
        typeof value.endpoint !== "string" ||
        (value.status !== "pending" && value.status !== "active" && value.status !== "revoked") ||
        typeof value.relay.reachable !== "boolean" ||
        typeof value.relay.online !== "boolean"
      ) {
        return [];
      }
      return [
        {
          id: value.id,
          instanceId: value.instanceId,
          displayName: value.displayName,
          endpoint: value.endpoint,
          status: value.status,
          relay: {
            reachable: value.relay.reachable,
            online: value.relay.online,
          },
        },
      ];
    });
  }

  async revoke(environmentRecordId: string): Promise<void> {
    const response = await this.#request(
      `/api/shiori-code/link/environments/${encodeURIComponent(environmentRecordId)}`,
      { method: "DELETE" },
    );
    if (!response.ok && response.status !== 404) {
      throw new Error(`Could not revoke ShioriCode Link (${response.status})`);
    }
  }
}
